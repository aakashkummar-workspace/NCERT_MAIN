import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { modelFor } from "./models";
import { NO_USAGE, type AIProvider, type AIRequest, type AIResult } from "./provider";

/**
 * The Anthropic provider.
 *
 * The only file in the codebase that imports the SDK; an ESLint rule blocks it
 * everywhere else. Four things here are deliberate rather than incidental:
 *
 * 1. **Structured output on every call.** `output_config.format` with the
 *    caller's own Zod schema, and the SDK parses against it. Never a prompt
 *    that asks the model to "reply only with JSON" and a regex on our side —
 *    that is how a model's bad day becomes a malformed question in front of a
 *    class.
 *
 * 2. **`stop_reason === "refusal"` is checked BEFORE the content is read.** A
 *    refusal is a normal outcome with a normal record, not a crash and not an
 *    empty question that looks real.
 *
 * 3. **Depth is `output_config.effort`, not a different model.** Switching
 *    models to get a better answer changes the price, the latency and the
 *    behaviour all at once; effort changes one thing.
 *
 * 4. **Streaming whenever `maxTokens` is large.** A long generation on a
 *    non-streaming request is an HTTP timeout waiting to happen, and the
 *    failure arrives after the money has been spent.
 *
 * Adaptive thinking (`{ type: "adaptive" }`) rather than `budget_tokens`, which
 * these models reject outright — it belongs to an older API generation.
 */

/** Above this, the request streams. Below it, the round trip is short enough. */
const STREAM_ABOVE_TOKENS = 2000;

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) {
      throw new Error(
        "AnthropicProvider needs ANTHROPIC_API_KEY. Without one the gateway " +
          "falls back to MockProvider — see src/ai/gateway.ts.",
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async complete<T>(request: AIRequest<T>): Promise<AIResult<T>> {
    const model = modelFor(request.tier);
    const started = Date.now();

    const params = {
      model: model.id,
      max_tokens: request.maxTokens,
      // The cache breakpoint. Everything in `system` is above it: role, rules,
      // output contract, curriculum, exemplars — long, identical between calls
      // and changing rarely. A timestamp or a request id up here invalidates
      // the prefix and roughly triples the bill with no visible symptom.
      system: request.cacheSystem
        ? [
            {
              type: "text" as const,
              text: request.system,
              cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
            },
          ]
        : request.system,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      thinking: { type: "adaptive" as const },
      output_config: {
        format: zodOutputFormat(request.schema),
        ...(request.effort ? { effort: request.effort } : {}),
      },
    };

    try {
      const message =
        request.maxTokens > STREAM_ABOVE_TOKENS
          ? await this.client.messages
              .stream(params, { timeout: model.timeoutMs })
              .finalMessage()
          : await this.client.messages.parse(params, { timeout: model.timeoutMs });

      const usage = {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
      };
      const latencyMs = Date.now() - started;

      // Before the content, not after.
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

      const parsed = request.schema.safeParse(message.parsed_output);
      if (!parsed.success) {
        // Parsed a second time on our side. The provider's own parse and ours
        // are both cheap, and a schema drift between them is the kind of thing
        // that otherwise surfaces as a runtime error in a page.
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
    } catch (error) {
      const latencyMs = Date.now() - started;
      const timedOut =
        error instanceof Error &&
        (error.name === "APIConnectionTimeoutError" ||
          /timeout/i.test(error.message));

      return {
        ok: false,
        kind: timedOut ? "timeout" : "error",
        message: error instanceof Error ? error.message : String(error),
        // A failed call may still have consumed tokens, and we cannot know how
        // many. Recorded as zero cost with a FAILED status rather than guessed:
        // a made-up number in a ledger is worse than a known gap.
        usage: NO_USAGE,
        model: model.id,
        latencyMs,
      };
    }
  }
}
