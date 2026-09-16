import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { signUp } from "@/core/identity/accounts";
import { runTask, setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import { defaultLimitMicros, windowFor } from "@/ai/budget";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";

afterAll(async () => {
  await prisma.$disconnect();
});

const Answer = z.object({ answer: z.string() });

let mock: MockProvider;

beforeEach(() => {
  mock = new MockProvider();
  setProvider(mock);
});

afterEach(() => {
  // Back to the real selection, so one suite cannot leave a mock behind.
  setProvider(null);
});

async function makeOrg() {
  const result = await signUp({
    fullName: "AI Teacher",
    email: `ai-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "AI Org",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!result.ok) throw new Error("signUp failed");

  const membership = await withTenant(result.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );
  return { organizationId: result.organizationId, userId: membership.userId };
}

function task(org: { organizationId: string; userId: string }, overrides = {}) {
  return {
    organizationId: org.organizationId,
    userId: org.userId,
    feature: "QUESTION_GENERATION" as const,
    tier: "BALANCED" as const,
    system: "You write CBSE questions.",
    messages: [{ role: "user" as const, content: "Write one." }],
    schema: Answer,
    schemaName: "Answer",
    maxTokens: 500,
    input: { conceptId: "c-1", difficulty: "HARD" },
    safeFields: ["conceptId", "difficulty"] as const,
    ...overrides,
  };
}

const usageFor = (organizationId: string) =>
  withTenant(organizationId, (tx) => tx.aIUsage.findMany());

const generationsFor = (organizationId: string) =>
  withTenant(organizationId, (tx) => tx.aIGeneration.findMany());

describe("the gateway records everything", () => {
  it("writes a usage row on success and closes the generation", async () => {
    const org = await makeOrg();
    mock.script({ kind: "ok", value: { answer: "42" } });

    const result = await runTask(task(org));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const usage = await usageFor(org.organizationId);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.status).toBe("SUCCEEDED");
    expect(Number(usage[0]!.costMicros)).toBeGreaterThan(0);

    const generations = await generationsFor(org.organizationId);
    expect(generations[0]!.status).toBe("SUCCEEDED");
    expect(generations[0]!.finishedAt).not.toBeNull();
  });

  it("writes a usage row for every failure too", async () => {
    // A retry storm is invisible in a success-only ledger, and that
    // invisibility is exactly what produces a surprise bill.
    const org = await makeOrg();
    mock.always = { kind: "error", message: "provider is down" };

    const result = await runTask(task(org));
    expect(result.ok).toBe(false);

    const usage = await usageFor(org.organizationId);
    // Three attempts, three rows.
    expect(usage).toHaveLength(3);
    expect(usage.every((row) => row.status === "FAILED")).toBe(true);
    expect(mock.callCount).toBe(3);
  });

  it("stores only the scrubbed payload as the input summary", async () => {
    const org = await makeOrg();
    mock.script({ kind: "ok", value: { answer: "42" } });

    await runTask(
      task(org, {
        input: { conceptId: "c-1", difficulty: "HARD", note: "Arun struggles here" },
        safeFields: ["conceptId", "difficulty"],
      }),
    );

    const generations = await generationsFor(org.organizationId);
    const summary = JSON.stringify(generations[0]!.inputSummary);
    // Debugging comfort is not a reason to keep the unscrubbed one.
    expect(summary).toContain("c-1");
    expect(summary).not.toContain("Arun");
    expect(summary).not.toContain("note");
  });
});

describe("the gateway refuses before it spends", () => {
  it("stops a call that would exceed the budget", async () => {
    const org = await makeOrg();
    const { start, end } = windowFor("DAY", new Date());

    await withTenant(org.organizationId, (tx) =>
      tx.aIBudget.create({
        data: {
          organizationId: org.organizationId,
          period: "DAY",
          feature: null,
          limitMicros: BigInt(100),
          spentMicros: BigInt(99),
          windowStart: start,
          windowEnd: end,
        },
      }),
    );

    const result = await runTask(task(org));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("BUDGET_EXCEEDED");
    // The point of checking first: the provider was never reached.
    expect(mock.callCount).toBe(0);
    expect(await usageFor(org.organizationId)).toHaveLength(0);
  });

  it("names the window that ran out", async () => {
    const org = await makeOrg();
    const { start, end } = windowFor("DAY", new Date());
    await withTenant(org.organizationId, (tx) =>
      tx.aIBudget.create({
        data: {
          organizationId: org.organizationId,
          period: "DAY",
          feature: null,
          limitMicros: BigInt(1),
          spentMicros: BigInt(1),
          windowStart: start,
          windowEnd: end,
        },
      }),
    );

    const result = await runTask(task(org));
    if (result.ok) return;
    // "Today" and "this month" need different things done about them.
    expect(result.message).toContain("today");
  });

  it("refuses to send a field that identifies a person", async () => {
    const org = await makeOrg();
    const result = await runTask(
      task(org, { input: { fullName: "Arun Kumar" }, safeFields: ["fullName"] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSAFE_PROMPT");
    expect(mock.callCount).toBe(0);
    // Nothing was attempted, so there is no generation to record.
    expect(await generationsFor(org.organizationId)).toHaveLength(0);
  });

  it("catches a name a template interpolated into the prompt itself", async () => {
    // The scrubbed payload was clean; the prompt was not. A template is exactly
    // where a phone number gets into a prompt without passing through scrub().
    const org = await makeOrg();
    const result = await runTask(
      task(org, {
        messages: [{ role: "user", content: "Write one for the student on 9876543210." }],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSAFE_PROMPT");
    expect(mock.callCount).toBe(0);
    // The generation IS recorded here — an attempt was made and stopped.
    const generations = await generationsFor(org.organizationId);
    expect(generations[0]!.status).toBe("FAILED");
    expect(generations[0]!.errorCode).toBe("UNSAFE_PROMPT");
  });

  it("caps how many generations one organisation can have in flight", async () => {
    const org = await makeOrg();
    await withTenant(org.organizationId, (tx) =>
      tx.aIGeneration.createMany({
        data: [0, 1, 2].map(() => ({
          organizationId: org.organizationId,
          requestedById: org.userId,
          feature: "QUESTION_GENERATION" as const,
          status: "RUNNING" as const,
        })),
      }),
    );

    const result = await runTask(task(org));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("TOO_MANY_IN_FLIGHT");
    expect(mock.callCount).toBe(0);
  });
});

describe("how the gateway handles a bad answer", () => {
  it("does not retry a refusal", async () => {
    // The model's decision will not change on a retry. Trying again spends
    // money to be told the same thing.
    const org = await makeOrg();
    mock.always = { kind: "refusal" };

    const result = await runTask(task(org));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REFUSED");
    expect(mock.callCount).toBe(1);

    const generations = await generationsFor(org.organizationId);
    expect(generations[0]!.status).toBe("REFUSED");
    // A refusal is a record, never a crash and never an empty question.
    const usage = await usageFor(org.organizationId);
    expect(usage[0]!.status).toBe("REFUSED");
  });

  it("takes one repair turn at malformed output, then gives up", async () => {
    const org = await makeOrg();
    mock.always = { kind: "invalid-output" };

    const result = await runTask(task(org));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_OUTPUT");
    expect(mock.callCount).toBe(3);

    // The repair turn tells the model what was wrong, below the cache
    // breakpoint, so the retry still reads the cached prefix.
    expect(mock.received[0]!.messages).toHaveLength(1);
    expect(mock.received[1]!.messages).toHaveLength(2);
    expect(mock.received[1]!.messages[1]!.content).toContain("did not match");
    expect(mock.received[1]!.system).toBe(mock.received[0]!.system);
  });

  it("recovers when a retry succeeds", async () => {
    const org = await makeOrg();
    mock.script({ kind: "error" }, { kind: "ok", value: { answer: "42" } });

    const result = await runTask(task(org));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.answer).toBe("42");

    // Both attempts are on the ledger, the failed one included.
    const usage = await usageFor(org.organizationId);
    expect(usage).toHaveLength(2);
    expect(usage.filter((row) => row.status === "FAILED")).toHaveLength(1);
  });

  it("never throws at a caller", async () => {
    // No AI call is on a blocking path, and a feature that has to try/catch
    // around one will eventually forget.
    const org = await makeOrg();
    mock.always = { kind: "timeout" };
    await expect(runTask(task(org))).resolves.toMatchObject({ ok: false });
  });
});

describe("the prompt cache", () => {
  it("keeps the prefix byte-identical across calls", async () => {
    // A single changed byte above the breakpoint invalidates everything after
    // it and roughly triples the bill, with no other symptom.
    const org = await makeOrg();
    mock.script(
      { kind: "ok", value: { answer: "one" } },
      { kind: "ok", value: { answer: "two" } },
    );

    await runTask(task(org));
    await runTask(task(org));

    expect(mock.received[0]!.system).toBe(mock.received[1]!.system);
    expect(mock.received[0]!.cacheSystem).toBe(true);
  });

  it("records what the cache actually saved", async () => {
    const org = await makeOrg();
    mock.script({
      kind: "ok",
      value: { answer: "42" },
      usage: { inputTokens: 10_000, cachedInputTokens: 9_000, outputTokens: 500 },
    });

    const result = await runTask(task(org));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cachedTokens).toBe(9_000);

    const usage = await usageFor(org.organizationId);
    // Asserted rather than assumed: if this is ever zero across repeated
    // generations, a silent invalidator has been introduced.
    expect(usage[0]!.cachedInputTokens).toBe(9_000);
  });
});

describe("spending is per organisation", () => {
  it("charges the organisation that made the call, and nobody else", async () => {
    const first = await makeOrg();
    const second = await makeOrg();

    mock.script({ kind: "ok", value: { answer: "42" } });
    await runTask(task(first));

    const theirs = await withTenant(second.organizationId, (tx) =>
      tx.aIUsage.findMany(),
    );
    expect(theirs).toHaveLength(0);

    const budgets = await withTenant(second.organizationId, (tx) =>
      tx.aIBudget.findMany(),
    );
    expect(budgets.every((row) => Number(row.spentMicros) === 0)).toBe(true);
  });

  it("opens a budget window on first use, at the default ceiling", async () => {
    const org = await makeOrg();
    mock.script({ kind: "ok", value: { answer: "42" } });
    await runTask(task(org));

    const budgets = await withTenant(org.organizationId, (tx) =>
      tx.aIBudget.findMany({ orderBy: { period: "asc" } }),
    );
    expect(budgets).toHaveLength(2);
    const month = budgets.find((row) => row.period === "MONTH")!;
    expect(Number(month.limitMicros)).toBe(defaultLimitMicros("MONTH"));
    expect(Number(month.spentMicros)).toBeGreaterThan(0);
  });
});
