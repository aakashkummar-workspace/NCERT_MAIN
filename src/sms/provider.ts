/**
 * What an SMS provider has to be able to do.
 *
 * ---------------------------------------------------------------------------
 * Why this is a seam at all
 * ---------------------------------------------------------------------------
 * Indian transactional SMS is not "post some text to an API". Every commercial
 * message must match a template registered with a DLT registry against a
 * registered sender id, and the provider rejects anything that does not — so
 * the choice of provider is entangled with paperwork, and the provider a school
 * ends up on is not a decision this code should be making.
 *
 * The same argument as `src/ai/provider.ts`: business logic names an INTENT,
 * one file names a vendor.
 */

export type SmsTemplateKey = "LOGIN_CODE" | "PARENT_INVITE";

export type SmsRequest = {
  /** E.164 without the plus, which is what Indian gateways take. */
  phone: string;
  template: SmsTemplateKey;
  /**
   * The variable parts, in the order the registered template declares them.
   *
   * Never free text. A DLT template is a fixed string with numbered slots, and
   * a message assembled any other way is rejected by the operator — so the
   * shape here is the shape the regulator approved, not one we chose.
   */
  variables: string[];
  /** The assembled body, for providers that want the whole string. */
  body: string;
};

export type SmsResult =
  | {
      ok: true;
      /** The provider's id, for reconciling against their dashboard later. */
      providerMessageId: string | null;
      /** What it cost, in millionths of a rupee. Null when unbilled. */
      costMicros: number | null;
    }
  | {
      ok: false;
      /**
       * Whether trying again could work.
       *
       * A rejected template is permanent — retrying it burns money to be told
       * the same thing, which is the rule the AI gateway follows about
       * refusals. A timeout is not.
       */
      retryable: boolean;
      /** The provider's own words. For the log, never for a person. */
      message: string;
    };

export interface SmsProvider {
  readonly name: string;
  send(request: SmsRequest): Promise<SmsResult>;
}

/**
 * Which provider is configured, if any.
 *
 * Deliberately explicit rather than inferred from whether a key happens to be
 * set: "we are not sending SMS yet" is a real, chosen state for a product that
 * has no provider account, and it should not be indistinguishable from a
 * missing environment variable.
 */
export function configuredProvider(): "none" | "log" | "msg91" {
  const named = (process.env.SMS_PROVIDER ?? "none").trim().toLowerCase();
  if (named === "msg91") return "msg91";
  if (named === "log") return "log";
  return "none";
}

export function hasSmsCredentials(): boolean {
  return (
    configuredProvider() === "msg91" &&
    Boolean(process.env.SMS_API_KEY) &&
    Boolean(process.env.SMS_SENDER_ID)
  );
}
