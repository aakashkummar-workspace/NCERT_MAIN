import type { AIProvider, AIRequest, AIResult } from "./provider";
import type { TokenUsage } from "./models";

/**
 * The provider the tests use, and the one that runs when no API key is set.
 *
 * Not a stub that returns `{}`. It is scripted: a caller queues the outcomes it
 * wants and the gateway sees them as it would see the real thing — including
 * refusals, timeouts and malformed output, which are the paths that actually
 * need testing. A mock that only ever succeeds tests the one case that was
 * never going to be the problem.
 *
 * It also counts calls and records the requests it received, so a test can
 * assert what a retry actually did and that nothing above the cache breakpoint
 * changed between two calls.
 */

export type Scripted<T = unknown> =
  | { kind: "ok"; value: T; usage?: Partial<TokenUsage> }
  | { kind: "refusal"; message?: string }
  | { kind: "invalid-output"; message?: string }
  | { kind: "timeout" }
  | { kind: "error"; message?: string };

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 1200,
  outputTokens: 400,
  cachedInputTokens: 0,
};

export class MockProvider implements AIProvider {
  readonly name = "mock";

  private queue: Scripted[] = [];
  /** Every request this provider received, in order. */
  readonly received: AIRequest<unknown>[] = [];

  /** What to return, once each, in order. Exhausted entries fall back to `always`. */
  script(...outcomes: Scripted[]): this {
    this.queue.push(...outcomes);
    return this;
  }

  /** The outcome for every call the script does not cover. */
  always: Scripted = { kind: "error", message: "MockProvider: nothing scripted" };

  get callCount(): number {
    return this.received.length;
  }

  async complete<T>(request: AIRequest<T>): Promise<AIResult<T>> {
    this.received.push(request as AIRequest<unknown>);
    const outcome = (this.queue.shift() ?? this.always) as Scripted<T>;
    const model = `mock-${request.tier.toLowerCase()}`;

    if (outcome.kind === "ok") {
      const usage = { ...DEFAULT_USAGE, ...outcome.usage };
      // Parsed through the caller's own schema, so a test that scripts the
      // wrong shape fails here rather than three layers downstream.
      const parsed = request.schema.safeParse(outcome.value);
      if (!parsed.success) {
        return {
          ok: false,
          kind: "invalid-output",
          message: `MockProvider: scripted value does not match ${request.schemaName}`,
          usage,
          model,
          latencyMs: 1,
        };
      }
      return { ok: true, value: parsed.data, usage, model, latencyMs: 1 };
    }

    return {
      ok: false,
      kind: outcome.kind,
      message:
        "message" in outcome && outcome.message
          ? outcome.message
          : `MockProvider: ${outcome.kind}`,
      usage: DEFAULT_USAGE,
      model,
      latencyMs: 1,
    };
  }
}
