import type { SmsProvider, SmsRequest, SmsResult } from "./provider";

/**
 * The provider the tests use.
 *
 * Scripted rather than always-succeeding, for the same reason `src/ai/mock.ts`
 * is: the paths worth testing are the ones that fail. A provider that only ever
 * returns ok tests the one case that was never going to be the problem.
 *
 * It records what it received so a test can assert what actually went on the
 * wire — in particular that the body matches the registered template, since an
 * unregistered body is dropped by the operator rather than by the provider and
 * is therefore invisible in any response.
 */
export type ScriptedSms =
  | { kind: "ok"; providerMessageId?: string; costMicros?: number }
  | { kind: "rejected"; message?: string }
  | { kind: "down"; message?: string }
  | { kind: "throws"; message?: string };

export class MockSmsProvider implements SmsProvider {
  readonly name = "mock";

  private queue: ScriptedSms[] = [];
  readonly received: SmsRequest[] = [];

  /** What to return, once each, in order. */
  script(...outcomes: ScriptedSms[]): this {
    this.queue.push(...outcomes);
    return this;
  }

  /** The outcome for every call the script does not cover. */
  always: ScriptedSms = { kind: "ok" };

  get callCount(): number {
    return this.received.length;
  }

  async send(request: SmsRequest): Promise<SmsResult> {
    this.received.push(request);
    const outcome = this.queue.shift() ?? this.always;

    switch (outcome.kind) {
      case "ok":
        return {
          ok: true,
          providerMessageId: outcome.providerMessageId ?? `mock-${this.received.length}`,
          // Roughly what one transactional segment costs in India, so a cost
          // assertion is against a plausible number rather than 1.
          costMicros: outcome.costMicros ?? 18_000,
        };
      case "rejected":
        // Permanent. A template the registry does not know will not start
        // working because we asked twice.
        return {
          ok: false,
          retryable: false,
          message: outcome.message ?? "template not registered",
        };
      case "down":
        return {
          ok: false,
          retryable: true,
          message: outcome.message ?? "gateway timeout",
        };
      case "throws":
        throw new Error(outcome.message ?? "provider exploded");
    }
  }
}
