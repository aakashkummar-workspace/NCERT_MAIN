import { tmpdir } from "node:os";
import { z } from "zod";
import { modelFor } from "./models";
import { claudeCodeAllowed } from "./local-database";
import { NO_USAGE, type AIProvider, type AIRequest, type AIResult } from "./provider";

export { claudeCodeAllowed };

/**
 * A development-only provider that answers through the developer's own
 * Claude Code login, via the Claude Agent SDK, instead of an API key.
 *
 * ---------------------------------------------------------------------------
 * Local testing only, and that is a rule of Anthropic's, not a preference
 * ---------------------------------------------------------------------------
 * The Agent SDK documentation: "Unless previously approved, Anthropic does not
 * allow third party developers to offer claude.ai login or rate limits for
 * their products, including agents built on the Claude Agent SDK." Sahayak's
 * users are teachers, students and parents, so a subscription login may power
 * the developer's own testing and nothing else. Three things hold that line:
 *
 * 1. `AI_PROVIDER="claude-code"` is a FATAL boot finding unless the database
 *    is on this machine (src/config/environment.ts). Every deployment has a
 *    remote database, so a production server refuses to start with it.
 * 2. The gateway re-checks the same thing before choosing this provider, so a
 *    `next dev` pointed at Supabase falls back to the mock rather than serving
 *    real schools through a personal login.
 * 3. The SDK is a devDependency, so a production install does not have it.
 *
 * ---------------------------------------------------------------------------
 * What it does and does not reproduce
 * ---------------------------------------------------------------------------
 * - Structured output, images and effort work as with the API provider: the
 *   caller's Zod schema becomes the SDK's JSON-schema output format, and the
 *   result is parsed against the same schema on our side.
 * - The SDK runs Claude Code as a subprocess per call: seconds of start-up and
 *   about 1 GB of memory each. Fine for one developer; the reason it could not
 *   serve a school even if it were allowed.
 * - No tools, no settings files, no session on disk, and a temp directory as
 *   the working directory: the subprocess is a model call and nothing else,
 *   and it cannot read this repository.
 * - The subprocess gets this process's environment MINUS anything that looks
 *   like a credential or a connection string. It needs PATH and the home
 *   directory to find the login; it does not need the database.
 * - Costs in the ledger are the SDK's estimate of what the same tokens would
 *   cost on the API. On a subscription nothing is billed per call, so the
 *   budget ceilings still bite at the same place they would in production.
 */

const CREDENTIAL = /DATABASE|PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE|CREDENTIAL/i;

function subprocessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!CREDENTIAL.test(key)) env[key] = value;
  }
  return env;
}

/**
 * The caller's Zod schema as the CLI's validator reads it: draft-07, and
 * without the `$schema` header — the CLI refuses a 2020-12 URI it has no
 * meta-schema for, before any model call.
 */
function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

type Block =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };
    };

/**
 * The SDK takes one user turn. The gateway's only multi-turn request is the
 * repair turn after malformed output, so earlier turns are folded into the one
 * message with their roles named — the model still sees what it said and what
 * was wrong with it.
 */
function toBlocks<T>(request: AIRequest<T>): Block[] {
  const blocks: Block[] = [];
  const many = request.messages.length > 1;
  for (const message of request.messages) {
    if (many) {
      blocks.push({
        type: "text",
        text: message.role === "assistant" ? "Your previous reply:" : "Request:",
      });
    }
    if (typeof message.content === "string") {
      blocks.push({ type: "text", text: message.content });
      continue;
    }
    for (const part of message.content) {
      blocks.push(
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } },
      );
    }
  }
  return blocks;
}

export class ClaudeCodeProvider implements AIProvider {
  readonly name = "claude-code";

  async complete<T>(request: AIRequest<T>): Promise<AIResult<T>> {
    const model = modelFor(request.tier);
    const started = Date.now();
    const fail = (kind: "refusal" | "invalid-output" | "timeout" | "error", message: string): AIResult<T> => ({
      ok: false,
      kind,
      message,
      usage: NO_USAGE,
      model: model.id,
      latencyMs: Date.now() - started,
    });

    // Checked here too, not only at boot: a provider that could be constructed
    // by a test or a script must still refuse to serve a remote database.
    if (!claudeCodeAllowed()) {
      return fail("error", "ClaudeCodeProvider refuses to run against a database that is not on this machine.");
    }

    let sdk: typeof import("@anthropic-ai/claude-agent-sdk");
    try {
      sdk = await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      return fail("error", "@anthropic-ai/claude-agent-sdk is not installed (it is a devDependency).");
    }

    const blocks = toBlocks(request);
    async function* prompt() {
      yield {
        type: "user" as const,
        parent_tool_use_id: null,
        message: { role: "user" as const, content: blocks },
      };
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), model.timeoutMs);

    try {
      for await (const message of sdk.query({
        prompt: prompt(),
        options: {
          model: model.id,
          systemPrompt: request.system,
          tools: [],
          settingSources: [],
          persistSession: false,
          cwd: tmpdir(),
          // One turn for the answer and one for the structured-output tool.
          maxTurns: 3,
          env: subprocessEnv(),
          abortController: abort,
          ...(request.effort ? { effort: request.effort } : {}),
          outputFormat: { type: "json_schema", schema: jsonSchemaFor(request.schema) },
        },
      })) {
        if (message.type !== "result") continue;

        const latencyMs = Date.now() - started;
        const usage = {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
          cachedInputTokens: message.usage?.cache_read_input_tokens ?? 0,
        };
        if (message.subtype !== "success") {
          return { ok: false, kind: "error", message: `Claude Code: ${message.subtype}`, usage, model: model.id, latencyMs };
        }
        if (message.stop_reason === "refusal") {
          return {
            ok: false,
            kind: "refusal",
            message: "The model declined to answer this request.",
            usage,
            model: model.id,
            latencyMs,
          };
        }
        const parsed = request.schema.safeParse(message.structured_output);
        if (!parsed.success) {
          return {
            ok: false,
            kind: "invalid-output",
            message: `Output did not match ${request.schemaName}.`,
            usage,
            model: model.id,
            latencyMs,
          };
        }
        return { ok: true, value: parsed.data, usage, model: model.id, latencyMs };
      }
      return fail("error", "Claude Code ended without a result.");
    } catch (error) {
      return abort.signal.aborted
        ? fail("timeout", `Claude Code did not answer within ${model.timeoutMs} ms.`)
        : fail("error", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
