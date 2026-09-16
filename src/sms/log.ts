import type { SmsProvider, SmsRequest, SmsResult } from "./provider";
import { describe } from "./templates";

/**
 * The development provider: it writes to the console instead of a handset.
 *
 * Chosen explicitly with `SMS_PROVIDER=log`, never inferred. Somebody working
 * on the sign-in flow needs to see the code, and reading it off a terminal is
 * the honest way to do that — as opposed to the current arrangement, where the
 * code is handed back in the API response and every caller has to remember that
 * it is only there outside production.
 *
 * It never logs in production, whatever the environment says. A one-time code
 * in a log file is a credential in a log file, and log files outlive the
 * incident that made somebody turn logging up.
 */
export class LogSmsProvider implements SmsProvider {
  readonly name = "log";

  async send(request: SmsRequest): Promise<SmsResult> {
    if (process.env.NODE_ENV === "production") {
      return {
        ok: false,
        retryable: false,
        message: "the log provider refuses to run in production",
      };
    }

    console.info(
      `[sms:log] to ${request.phone} — ${describe(request.template)}\n         ${request.body}`,
    );
    return { ok: true, providerMessageId: null, costMicros: 0 };
  }
}
