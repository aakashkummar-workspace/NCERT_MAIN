import type { ZodType } from "zod";
import type { ModelTier, TokenUsage } from "./models";
import { claudeCodeAllowed } from "./local-database";

/**
 * The provider seam.
 *
 * Everything above this line names a tier and a schema. Everything below it
 * knows about an SDK. Feature code may not import either — an ESLint rule
 * blocks `@anthropic-ai/sdk` outside `src/ai/`, because one direct
 * `new Anthropic()` in a route handler bypasses model routing, the budget
 * check and PII scrubbing at the same moment.
 */

/**
 * One piece of a message. An image is a photograph of a student's written
 * answer, sent for marking assistance and nothing else — see
 * core/marking-assist. It is bytes the leak check cannot read, which is why
 * the only caller photographs the answer and not the page it sits on.
 */
export type AIContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/jpeg" | "image/png" | "image/webp"; data: string };

export type AIMessage = { role: "user" | "assistant"; content: string | AIContentPart[] };

/** The text of a message, for the leak check and the ledger. Images are not text. */
export function textOf(message: AIMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
}

export type AIRequest<T> = {
  tier: ModelTier;
  /**
   * Everything above the cache breakpoint: role, rules, output contract,
   * curriculum context, exemplars. Long, identical between calls, and cached.
   */
  system: string;
  messages: AIMessage[];
  /**
   * Structured output, always. A free-form string that some caller then parses
   * with a regex is prohibited — that is how a model's bad day becomes a
   * malformed question in front of a class.
   */
  schema: ZodType<T>;
  /** A name for the schema, for the provider's structured-output contract. */
  schemaName: string;
  maxTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh";
  /** Marks the end of the cacheable prefix. Nothing volatile above it. */
  cacheSystem?: boolean;
};

export type AIResult<T> =
  | { ok: true; value: T; usage: TokenUsage; model: string; latencyMs: number }
  | {
      ok: false;
      /**
       * `refusal` is the model declining, and it is a normal outcome rather
       * than a crash: a REFUSED record, never an empty question shown to a
       * teacher as though it were real.
       */
      kind: "refusal" | "invalid-output" | "timeout" | "error";
      message: string;
      usage: TokenUsage;
      model: string;
      latencyMs: number;
    };

export interface AIProvider {
  readonly name: string;
  complete<T>(request: AIRequest<T>): Promise<AIResult<T>>;
}

export const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

/**
 * Whether a real provider is configured at all: an API key, or the
 * development-only Claude Code provider on a local database (src/ai/claude-code.ts).
 */
export function hasProviderCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) || claudeCodeAllowed();
}
