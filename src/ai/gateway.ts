import "server-only";
import type { ZodType } from "zod";
import { withTenant } from "@/db/tenant";
import { costMicros, modelFor, uncachedCostMicros, type ModelTier } from "./models";
import { checkBudget, recordSpend } from "./budget";
import { checkForLeaks, scrub, type SafeValue } from "./scrub";
import { can, recordUse } from "@/core/billing/entitlements";
import { MockProvider } from "./mock";
import { AnthropicProvider } from "./anthropic";
import {
  hasProviderCredentials,
  type AIMessage,
  type AIProvider,
  type AIResult,
} from "./provider";

/**
 * The gateway. Every AI call in the product goes through here, in this order:
 *
 *     concurrency → budget → scrub → leak check → call → validate
 *       → retry or refuse → usage ledger → budget spend
 *
 * The order is the design. Budget before the call, because a limit checked
 * afterwards is a report. The leak check after assembly, because a prompt is
 * built from template strings and a template is exactly where a name gets
 * interpolated without passing through a scrubbed payload. The ledger after
 * every call including the failed ones, because a retry storm is invisible in a
 * success-only ledger and that invisibility is what produces a surprise bill.
 *
 * ---------------------------------------------------------------------------
 * What this guarantees to a caller
 * ---------------------------------------------------------------------------
 * - It never throws. Every failure is a typed result, because **no AI call is
 *   on a blocking path** and a feature that has to try/catch around one will
 *   eventually forget.
 * - It never sends a name, a number or an address. See `scrub.ts`.
 * - It never returns unvalidated output. The schema is the contract.
 */

export type AIFeature =
  | "QUESTION_GENERATION"
  | "QUESTION_VALIDATION"
  | "PERFORMANCE_ANALYSIS"
  | "TEACHER_COPILOT"
  | "STUDENT_TUTOR"
  | "REPORT_GENERATION"
  | "RECOMMENDATION"
  | "CLASSIFICATION";

export type TaskRequest<T> = {
  organizationId: string;
  userId: string;
  feature: AIFeature;
  tier: ModelTier;
  /** Everything above the cache breakpoint. Nothing volatile in here. */
  system: string;
  messages: AIMessage[];
  schema: ZodType<T>;
  schemaName: string;
  maxTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh";
  /**
   * The payload this task is about, and the fields of it that are safe to send.
   * Scrubbed here and stored as `input_summary` — the scrubbed copy only.
   */
  input: Record<string, unknown>;
  safeFields: readonly string[];
  promptVersion?: string;
  /** How many items the caller asked for, for the generation record. */
  requestedCount?: number;
  /**
   * The entitlement this call spends, if it is metered.
   *
   * Checked BEFORE the budget: the plan says whether the feature is included at
   * all, and money is a separate question. A teacher on Free who has used their
   * five generations should be told about their plan, not about a dollar
   * ceiling they have never heard of.
   */
  entitlementKey?: string;
};

export type FailureCode =
  | "NOT_ENTITLED"
  | "BUDGET_EXCEEDED"
  | "TOO_MANY_IN_FLIGHT"
  | "REFUSED"
  | "INVALID_OUTPUT"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "UNSAFE_PROMPT";

export type TaskOutcome<T> =
  | { ok: true; value: T; generationId: string; costMicros: number; cachedTokens: number }
  | {
      ok: false;
      generationId: string;
      code: FailureCode;
      message: string;
      costMicros: number;
    };

/** In-flight generations per organization. A runaway loop is bounded here. */
const MAX_IN_FLIGHT = 3;

/** Two retries, on transient failures only. */
const MAX_ATTEMPTS = 3;

let cached: AIProvider | null = null;

/**
 * The provider in use.
 *
 * Falls back to the mock when no key is configured, so the whole product runs
 * in development and in CI with the AI layer wired up and costing nothing —
 * and so a missing key is a visibly mocked answer rather than a crash on a
 * page a teacher opened.
 */
export function provider(): AIProvider {
  if (cached) return cached;
  cached = hasProviderCredentials() ? new AnthropicProvider() : new MockProvider();
  return cached;
}

/** Tests replace the provider; nothing else should. */
export function setProvider(next: AIProvider | null): void {
  cached = next;
}

export async function runTask<T>(request: TaskRequest<T>): Promise<TaskOutcome<T>> {
  const now = new Date();
  const model = modelFor(request.tier);

  // Pessimistic: max output at full price, no cache credit. Refusing a call
  // that would have come in under budget costs one retry; allowing one that
  // blows through the limit is discovered on an invoice.
  const estimate = uncachedCostMicros(request.tier, {
    inputTokens: Math.ceil(request.system.length / 3),
    outputTokens: request.maxTokens,
    cachedInputTokens: 0,
  });

  let summary: Record<string, SafeValue>;
  try {
    summary = scrub(request.input, request.safeFields);
  } catch (error) {
    // A caller asking to send a phone number has misunderstood something. No
    // generation record, because nothing was attempted.
    return {
      ok: false,
      generationId: "",
      code: "UNSAFE_PROMPT",
      message: error instanceof Error ? error.message : String(error),
      costMicros: 0,
    };
  }

  // --- Gate, then open the record ------------------------------------------

  if (request.entitlementKey) {
    const verdict = await can(request.organizationId, request.entitlementKey, now);
    if (!verdict.allowed) {
      return {
        ok: false,
        generationId: "",
        code: "NOT_ENTITLED",
        message:
          verdict.reason === "limit-reached"
            ? `You have used all ${verdict.limit} of this month's AI generations on your plan.`
            : "Your plan does not include this.",
        costMicros: 0,
      };
    }
  }

  const opened = await withTenant(request.organizationId, async (tx) => {
    const inFlight = await tx.aIGeneration.count({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (inFlight >= MAX_IN_FLIGHT) {
      return { gate: "TOO_MANY_IN_FLIGHT" as const };
    }

    const budget = await checkBudget(tx, request.organizationId, estimate, now);
    if (!budget.ok) {
      return { gate: "BUDGET_EXCEEDED" as const, budget };
    }

    const generation = await tx.aIGeneration.create({
      data: {
        organizationId: request.organizationId,
        requestedById: request.userId,
        feature: request.feature,
        status: "RUNNING",
        // The scrubbed payload, and only that.
        inputSummary: summary,
        requestedCount: request.requestedCount ?? 1,
        startedAt: now,
      },
    });
    return { gate: "OPEN" as const, generationId: generation.id };
  });

  if (opened.gate === "TOO_MANY_IN_FLIGHT") {
    return {
      ok: false,
      generationId: "",
      code: "TOO_MANY_IN_FLIGHT",
      message:
        "There are already several generations running for your organisation. Wait for one to finish.",
      costMicros: 0,
    };
  }

  if (opened.gate === "BUDGET_EXCEEDED") {
    const { period, limitMicros, spentMicros } = opened.budget;
    return {
      ok: false,
      generationId: "",
      code: "BUDGET_EXCEEDED",
      message:
        period === "DAY"
          ? "This organisation has used its AI allowance for today. It resets tomorrow."
          : "This organisation has used its AI allowance for this month.",
      costMicros: spentMicros > limitMicros ? spentMicros : 0,
    };
  }

  const generationId = opened.generationId;

  // --- The prompt leaves the building --------------------------------------

  const leak = checkForLeaks(
    [request.system, ...request.messages.map((m) => m.content)].join("\n"),
  );
  if (!leak.ok) {
    await finish(request, generationId, "FAILED", "UNSAFE_PROMPT", now);
    return {
      ok: false,
      generationId,
      code: "UNSAFE_PROMPT",
      message: `The assembled prompt contains something that looks like a ${leak.kind}. Nothing was sent.`,
      costMicros: 0,
    };
  }

  let spent = 0;
  let last: AIResult<T> | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // One repair turn on malformed output: the model is told what was wrong
    // rather than asked the same question again. Appended BELOW the cache
    // breakpoint, so the retry still reads the cached prefix.
    const repairing = attempt > 1 && last !== null && !last.ok && last.kind === "invalid-output";
    const messages: AIMessage[] = repairing
      ? [
          ...request.messages,
          {
            role: "user",
            content:
              `Your previous reply did not match the required ${request.schemaName} schema. ` +
              `Reply again, with exactly that shape and nothing else.`,
          },
        ]
      : request.messages;

    const result = await provider().complete<T>({
      tier: request.tier,
      system: request.system,
      messages,
      schema: request.schema,
      schemaName: request.schemaName,
      maxTokens: request.maxTokens,
      effort: request.effort,
      cacheSystem: true,
    });

    last = result;
    const micros = costMicros(request.tier, result.usage);
    spent += micros;

    await withTenant(request.organizationId, async (tx) => {
      await tx.aIUsage.create({
        data: {
          generationId,
          organizationId: request.organizationId,
          feature: request.feature,
          provider: provider().name,
          model: result.model || model.id,
          promptVersion: request.promptVersion,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          latencyMs: result.latencyMs,
          costMicros: BigInt(micros),
          status: result.ok
            ? "SUCCEEDED"
            : result.kind === "refusal"
              ? "REFUSED"
              : result.kind === "timeout"
                ? "TIMED_OUT"
                : "FAILED",
        },
      });
      await recordSpend(tx, request.organizationId, micros, now);
    });

    if (result.ok) {
      // Counted after it worked, never before. A teacher whose five monthly
      // generations were spent on provider timeouts has been charged for
      // nothing, and would be right to say so.
      if (request.entitlementKey) {
        await recordUse(request.organizationId, request.entitlementKey, 1, now);
      }
      await finish(request, generationId, "SUCCEEDED", null, now, 1);
      return {
        ok: true,
        value: result.value,
        generationId,
        costMicros: spent,
        cachedTokens: result.usage.cachedInputTokens,
      };
    }

    // A refusal is the model's decision and will not change on a retry. Trying
    // again would spend money to be told the same thing.
    if (result.kind === "refusal") break;

    if (attempt < MAX_ATTEMPTS) {
      // Exponential with jitter: a synchronised retry from twenty tenants is
      // its own outage.
      const backoff = 250 * 2 ** (attempt - 1);
      await sleep(backoff + Math.floor(Math.random() * backoff));
    }
  }

  const kind = last && !last.ok ? last.kind : "error";
  const code =
    kind === "refusal"
      ? "REFUSED"
      : kind === "invalid-output"
        ? "INVALID_OUTPUT"
        : kind === "timeout"
          ? "TIMEOUT"
          : "PROVIDER_ERROR";

  await finish(
    request,
    generationId,
    kind === "refusal" ? "REFUSED" : "FAILED",
    code,
    now,
  );

  // The provider's own words go to the ledger and the log, never to a person.
  // "MockProvider: nothing scripted" and a stack-shaped SDK message are both
  // true and both useless to a teacher who pressed a button.
  if (last && !last.ok) {
    console.error(`[ai] ${request.feature} ${code}: ${last.message}`);
  }

  return {
    ok: false,
    generationId,
    code,
    // With no key configured the "provider" is the mock, and it will fail the
    // same way on every press. Telling a teacher to "try again in a moment"
    // sends them round a loop that cannot end; the honest sentence is that the
    // feature is not switched on here. The code stays PROVIDER_ERROR — only
    // what a person reads changes.
    message:
      code === "PROVIDER_ERROR" && !hasProviderCredentials()
        ? NOT_CONFIGURED_MESSAGE
        : USER_MESSAGE[code],
    costMicros: spent,
  };
}

const NOT_CONFIGURED_MESSAGE =
  "AI generation is not set up on this deployment, so nothing was generated and nothing was saved. Ask whoever runs Sahayak for your school to switch it on.";

/**
 * What a person reads.
 *
 * Each one says what happened, what survived, and what to do next — the same
 * contract as every other error message in the product.
 */
const USER_MESSAGE: Record<FailureCode, string> = {
  NOT_ENTITLED: "Your plan does not include this.",
  BUDGET_EXCEEDED: "This organisation has used its AI allowance.",
  TOO_MANY_IN_FLIGHT:
    "There are already several generations running. Wait for one to finish.",
  UNSAFE_PROMPT: "Nothing was sent, because the request contained personal details.",
  REFUSED:
    "The model declined to write this. Try a different chapter or a different difficulty.",
  INVALID_OUTPUT:
    "What came back was not usable, twice. Nothing was saved — try again, or write the question yourself.",
  TIMEOUT:
    "The model took too long. Nothing was saved and nothing was lost — try a smaller batch.",
  PROVIDER_ERROR:
    "The model could not be reached. Nothing was saved — try again in a moment.",
};

async function finish<T>(
  request: TaskRequest<T>,
  generationId: string,
  status: "SUCCEEDED" | "FAILED" | "REFUSED" | "PARTIAL",
  errorCode: string | null,
  now: Date,
  producedCount = 0,
): Promise<void> {
  await withTenant(request.organizationId, (tx) =>
    tx.aIGeneration.update({
      where: { id: generationId },
      data: {
        status,
        errorCode,
        producedCount,
        finishedAt: new Date(Math.max(now.getTime(), Date.now())),
      },
    }),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
