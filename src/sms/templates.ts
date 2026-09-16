import type { SmsTemplateKey } from "./provider";

/**
 * The messages, and the shape the regulator approved.
 *
 * ---------------------------------------------------------------------------
 * A DLT template is not a string you can edit
 * ---------------------------------------------------------------------------
 * India's TRAI regulations require every commercial SMS to match a template
 * registered with a DLT registry, under a registered sender id and a registered
 * header. The operator matches the delivered text against the registered one;
 * anything else is dropped at the network, not by the provider, and often
 * silently.
 *
 * So changing a word here is not a copy change. It means re-registering the
 * template, waiting for approval, and updating `dltTemplateId` — and until all
 * three have happened the old text is the only one that will arrive. That is
 * why the body lives beside the id it was registered under, rather than being
 * assembled at the call site.
 *
 * ---------------------------------------------------------------------------
 * The code is never in a log line
 * ---------------------------------------------------------------------------
 * `describe()` exists so a ledger row and a log line can say WHICH message was
 * sent without repeating what was in it. A one-time code written to a log file
 * is a credential written to a log file, and log files are read by more people,
 * for longer, than anybody intends.
 */

export type Template = {
  key: SmsTemplateKey;
  /** The registered id. Empty until the paperwork is done for a given account. */
  dltTemplateId: string;
  /** How many variables the registered template declares. */
  arity: number;
  build: (variables: string[]) => string;
};

/**
 * How long a code lives, said in the message.
 *
 * Matches `CODE_TTL_MS` in `core/identity/student-auth.ts`. Stated in both
 * places because a message that promises ten minutes while the code expires in
 * five is a support call, and there is no way to derive one from the other
 * across a template a regulator has approved.
 */
export const CODE_MINUTES = 5;

export const TEMPLATES: Record<SmsTemplateKey, Template> = {
  LOGIN_CODE: {
    key: "LOGIN_CODE",
    dltTemplateId: process.env.SMS_TEMPLATE_LOGIN_CODE ?? "",
    arity: 1,
    // Deliberately plain, and deliberately naming the product: a six-digit
    // number arriving from an unfamiliar sender is one a student ignores or,
    // worse, reads out to whoever asked for it.
    build: ([code]) =>
      `${code} is your Sahayak sign-in code. It works for ${CODE_MINUTES} minutes. Do not share it with anyone.`,
  },
  PARENT_INVITE: {
    key: "PARENT_INVITE",
    dltTemplateId: process.env.SMS_TEMPLATE_PARENT_INVITE ?? "",
    arity: 2,
    build: ([childName, link]) =>
      `${childName}'s school has invited you to see their progress on Sahayak. Open ${link} to accept.`,
  },
};

export function buildBody(key: SmsTemplateKey, variables: string[]): string {
  const template = TEMPLATES[key];
  if (variables.length !== template.arity) {
    // Thrown rather than padded. A DLT template with the wrong number of
    // variables is rejected by the operator, so guessing here converts a
    // programming mistake into a message that silently never arrives.
    throw new Error(
      `${key} takes ${template.arity} variables, got ${variables.length}`,
    );
  }
  return template.build(variables);
}

/** What a log line or a ledger row may say about this message. */
export function describe(key: SmsTemplateKey): string {
  return key === "LOGIN_CODE" ? "a sign-in code" : "a parent invitation";
}
