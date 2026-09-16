import "server-only";
import { randomUUID } from "node:crypto";
import {
  closeSmsAttempt,
  recordSmsAttempt,
  smsSentToday,
} from "@/db/unscoped";
import { buildBody, describe } from "./templates";
import {
  configuredProvider,
  hasSmsCredentials,
  type SmsProvider,
  type SmsRequest,
  type SmsTemplateKey,
} from "./provider";
import { MockSmsProvider } from "./mock";
import { LogSmsProvider } from "./log";
import { Msg91Provider } from "./msg91";

/**
 * Sending an SMS.
 *
 * ---------------------------------------------------------------------------
 * The order is the design, and it is the AI gateway's order
 * ---------------------------------------------------------------------------
 *   validate the number → daily ceiling → open a ledger row → send →
 *   close the row, whatever happened
 *
 * The ceiling comes BEFORE the send, because a limit checked afterwards is a
 * report. The ledger row is opened before and closed after, because a
 * success-only ledger hides exactly the message somebody is ringing about.
 *
 * ---------------------------------------------------------------------------
 * It never throws
 * ---------------------------------------------------------------------------
 * Delivery sits on the sign-in path. A student who cannot get a code because
 * the provider is down is a bad afternoon; a student who gets a 500 on the
 * sign-in form because the provider is down is a broken product. Every failure
 * here is a typed result, and the caller decides what the person is told.
 *
 * ---------------------------------------------------------------------------
 * Two different limits, and conflating them would be the bug
 * ---------------------------------------------------------------------------
 * `app_auth_issue_code` already refuses more than a few codes to one NUMBER in
 * an hour. That is the product promise: it protects the person whose phone
 * would otherwise buzz all night.
 *
 * `DAILY_CEILING` here protects US. An attacker cycling through ten thousand
 * different numbers passes the per-number limit every time and spends real
 * money doing it, because SMS is billed per message. Same distinction the AI
 * gateway draws between `usage_counters` and `ai_budgets` — one is what we
 * promised, the other is what we can afford, and a price change must not be
 * able to move a safety control.
 */

/**
 * How many messages the whole product may send in a day.
 *
 * Deliberately low for an unlaunched product, and deliberately a constant
 * rather than an entitlement: this is not something a plan buys. Raise it when
 * real traffic justifies it, and notice that raising it is a decision somebody
 * made rather than a number that drifted.
 */
export const DAILY_CEILING = Number(process.env.SMS_DAILY_CEILING ?? 2000);

/** Indian mobile numbers, as the gateways take them. */
const MOBILE = /^[6-9]\d{9}$/;

export type SendOutcome =
  | { ok: true; messageId: string; status: "SENT" }
  | {
      ok: false;
      messageId: string | null;
      reason: "not-configured" | "invalid-number" | "ceiling" | "provider";
      /** For the log. A provider's words never reach a person. */
      detail: string;
    };

let cached: SmsProvider | null = null;

/**
 * The provider in use.
 *
 * `none` is the default and is a real state, not a misconfiguration: this
 * product has no provider account yet. It is reported as `not-configured`
 * rather than pretending to succeed, so a deployment without credentials fails
 * loudly in the one place it matters instead of silently swallowing every code.
 */
function provider(): SmsProvider | null {
  if (cached) return cached;
  const named = configuredProvider();

  if (named === "log") {
    cached = new LogSmsProvider();
    return cached;
  }
  if (named === "msg91" && hasSmsCredentials()) {
    cached = new Msg91Provider();
    return cached;
  }
  // `msg91` named without credentials falls through to null and is reported as
  // `not-configured`. It is also a FATAL finding at boot in
  // `src/config/environment.ts` — somebody who typed the provider name meant to
  // turn SMS on, and silently sending nothing hides their mistake behind a
  // product that looks fine.
  return null;
}

/** Tests replace the provider; nothing else does. */
export function setSmsProvider(next: SmsProvider | null): void {
  cached = next;
}

export async function sendSms(input: {
  phone: string;
  template: SmsTemplateKey;
  variables: string[];
  /** Null for anything sent before a tenant is known — a sign-in code. */
  organizationId?: string | null;
}): Promise<SendOutcome> {
  const phone = input.phone.trim();

  if (!MOBILE.test(phone)) {
    // Refused before a row is written: there is nothing to trace, and a ledger
    // full of malformed numbers is a ledger nobody reads.
    return {
      ok: false,
      messageId: null,
      reason: "invalid-number",
      detail: "not an Indian mobile number",
    };
  }

  // Through the pre-tenant seam, not the tenant client: a sign-in code belongs
  // to no organisation, so nothing here can run inside `withTenant`.
  const sentToday = await smsSentToday();

  const chosen = provider();
  const messageId = randomUUID();

  // The row exists before the send, so a process that dies mid-flight leaves
  // evidence rather than silence.
  await recordSmsAttempt({
    id: messageId,
    organizationId: input.organizationId ?? null,
    phone,
    template: input.template,
    provider: chosen?.name ?? null,
  });

  if (sentToday >= DAILY_CEILING) {
    await close(messageId, "SKIPPED", { error: "daily ceiling reached" });
    console.error(
      `[sms] refused ${describe(input.template)}: the daily ceiling of ${DAILY_CEILING} is reached`,
    );
    return {
      ok: false,
      messageId,
      reason: "ceiling",
      detail: "daily ceiling reached",
    };
  }

  if (!chosen) {
    await close(messageId, "SKIPPED", { error: "no SMS provider is configured" });
    return {
      ok: false,
      messageId,
      reason: "not-configured",
      detail: "no SMS provider is configured",
    };
  }

  let request: SmsRequest;
  try {
    request = {
      phone,
      template: input.template,
      variables: input.variables,
      body: buildBody(input.template, input.variables),
    };
  } catch (error) {
    await close(messageId, "FAILED", { error: String(error) });
    return {
      ok: false,
      messageId,
      reason: "provider",
      detail: String(error),
    };
  }

  try {
    const result = await chosen.send(request);
    if (result.ok) {
      await close(messageId, "SENT", {
        providerMessageId: result.providerMessageId,
        costMicros: result.costMicros,
      });
      return { ok: true, messageId, status: "SENT" };
    }

    await close(messageId, "FAILED", { error: result.message });
    // The provider's words go here and no further. "Invalid template id 1707…"
    // is true and useless to a fifteen-year-old who cannot sign in.
    console.error(
      `[sms] ${describe(input.template)} failed via ${chosen.name}: ${result.message}`,
    );
    return { ok: false, messageId, reason: "provider", detail: result.message };
  } catch (error) {
    // A provider that throws is a provider that is down. Recorded, not raised.
    const detail = error instanceof Error ? error.message : String(error);
    await close(messageId, "FAILED", { error: detail });
    console.error(`[sms] ${chosen.name} threw: ${detail}`);
    return { ok: false, messageId, reason: "provider", detail };
  }
}

async function close(
  id: string,
  status: "SENT" | "FAILED" | "SKIPPED",
  fields: {
    providerMessageId?: string | null;
    costMicros?: number | null;
    error?: string | null;
  },
): Promise<void> {
  try {
    await closeSmsAttempt({ id, status, ...fields });
  } catch (error) {
    // The ledger failing must not take the send with it. Same rule as the
    // evidence ledger: the thing that already happened is more important than
    // the record of it.
    console.error(`[sms] could not close ${id}:`, error);
  }
}

export { MockSmsProvider };
