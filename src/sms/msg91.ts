import { TEMPLATES, describe } from "./templates";
import type { SmsProvider, SmsRequest, SmsResult } from "./provider";

/**
 * MSG91, over their v5 "flow" endpoint.
 *
 * ---------------------------------------------------------------------------
 * Where this shape came from
 * ---------------------------------------------------------------------------
 * Written against MSG91's own API documentation, not from recall:
 *
 *   https://api.msg91.com/apidoc/textsms/send-sms-flow.php   endpoint, headers,
 *                                                            body, responses
 *   https://api.msg91.com/apidoc/errorCode/errorCodes.php     the code list
 *   https://api.msg91.com/apidoc/textsms/error-code-text-sms.php
 *
 * Documented verbatim there:
 *
 *   POST https://api.msg91.com/api/v5/flow/
 *   authkey: <key>
 *   content-type: application/json
 *
 *   { "flow_id": "...", "sender": "...",
 *     "recipients": [ { "mobiles": 919898989898, "VAR1": "...", ... } ] }
 *
 *   success  { "message": "5762846b4f8d285d378b4567", "type": "success" }
 *   error    { "message": "flow id missing", "type": "error" }        (+ "code")
 *
 * That matters more here than it usually would. A wrong field name against this
 * API does not fail loudly: the request is accepted, the ledger records a send,
 * and a fifteen-year-old's phone never buzzes. So every field below is one that
 * appears in their documentation, and nothing is sent on a guess.
 *
 * ---------------------------------------------------------------------------
 * It never throws
 * ---------------------------------------------------------------------------
 * Same guarantee `sendSms()` makes, made one layer lower so it does not depend
 * on the gateway's try/catch being remembered. Delivery sits on the sign-in
 * path: a provider being down is a bad afternoon, a 500 on the sign-in form is
 * a broken product.
 *
 * ---------------------------------------------------------------------------
 * The code is never written down
 * ---------------------------------------------------------------------------
 * Nothing in this file logs `request.body`, `request.variables`, or the request
 * payload. Log lines say WHICH message this was via `describe()` and stop
 * there. A one-time code in a log file is a credential in a log file, and log
 * files outlive the incident that raised the log level.
 *
 * The provider's own error prose is logged and never returned to a person —
 * "Invalid authentication key" is true and useless to a student who cannot sign
 * in — so the returned `message` is assembled from OUR mapping of their code.
 */

/** The documented v5 flow endpoint. */
const DEFAULT_ENDPOINT = "https://api.msg91.com/api/v5/flow/";

/**
 * Eight seconds.
 *
 * This is not a background job: a student is holding a phone, staring at a
 * sign-in form, waiting for this call to come back. Much longer and they press
 * the button again — which issues a second code, spends a second message, and
 * invalidates the first. Much shorter and a merely slow gateway is reported as
 * an outage. Eight is comfortably above MSG91's normal response and well below
 * the point where somebody gives up on the form.
 *
 * The important half is that there IS one. Node's fetch has no default timeout,
 * so a hung provider would otherwise hold the sign-in request open until the
 * platform's own limit killed it.
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * India, and only India.
 *
 * `sendSms()` has already refused anything that is not a ten-digit Indian
 * mobile, and MSG91 wants the number in international format without a plus
 * (their example is 919898989898). This is a constant rather than a setting
 * because the DLT registration, the sender id and the templates are all Indian
 * too — a second country is a second lot of paperwork, not a variable.
 */
const COUNTRY_CODE = "91";

/**
 * Codes that will say the same thing tomorrow.
 *
 * Retrying one of these spends a request to be told what we already know —
 * the same rule the AI gateway follows about refusals. Everything NOT on this
 * list is treated as retryable, which is the safe direction: a message that
 * could have arrived and did not is worse than one sent twice, and MSG91
 * discards a duplicate request within ten seconds anyway (code 311).
 */
const PERMANENT_CODES = new Set([
  "101", // missing mobile no.
  "102", // missing message
  "103", // missing sender ID
  "104", // missing username
  "105", // missing password
  "106", // missing authentication key
  "107", // missing route
  "202", // invalid mobile number
  "203", // invalid sender ID
  "205", // route is for high traffic only
  "207", // invalid authentication key
  "208", // IP is blacklisted
  "209", // default route for dialplan not found
  "210", // route could not be determined
  "301", // insufficient balance
  "302", // expired user account
  "303", // banned user account
  "306", // route unavailable outside 9AM-9PM
  "307", // incorrect scheduled time
  "308", // campaign name too long
  "309", // group does not belong to you
  "310", // SMS too long
  "418", // IP is not whitelisted
  "505", // demo account
  "506", // small campaign limit exceeded
]);

/** Our words for their codes. Their prose never reaches this string. */
const CODE_MEANING: Record<string, string> = {
  "101": "no mobile number reached the provider",
  "102": "no message body reached the provider",
  "103": "no sender id reached the provider",
  "106": "no auth key reached the provider",
  "107": "no route reached the provider",
  "202": "the provider read the mobile number as invalid",
  "203": "the sender id is not six alphabetic characters",
  "207": "the auth key is not valid for this account",
  "208": "this server's IP is blacklisted at the provider",
  "301": "the account has no balance left",
  "302": "the provider account has expired",
  "303": "the provider account is banned",
  "310": "the assembled message is longer than the provider accepts",
  "311": "the provider discarded it as a duplicate of a request ten seconds ago",
  "418": "this server's IP is not whitelisted at the provider",
  "505": "the provider account is still a demo account",
  "601": "the provider reported an internal error",
};

export type Msg91Options = {
  authKey?: string;
  senderId?: string;
  endpoint?: string;
  timeoutMs?: number;
  /** Injected by the tests. Nothing else passes one. */
  fetchImpl?: typeof globalThis.fetch;
};

export class Msg91Provider implements SmsProvider {
  readonly name = "msg91";

  private readonly authKey: string;
  private readonly senderId: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: Msg91Options = {}) {
    this.authKey = (options.authKey ?? process.env.SMS_API_KEY ?? "").trim();
    this.senderId = (options.senderId ?? process.env.SMS_SENDER_ID ?? "").trim();
    this.endpoint = (
      options.endpoint ??
      process.env.SMS_MSG91_ENDPOINT ??
      DEFAULT_ENDPOINT
    ).trim();
    this.timeoutMs =
      options.timeoutMs ??
      Number(process.env.SMS_MSG91_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async send(request: SmsRequest): Promise<SmsResult> {
    try {
      return await this.attempt(request);
    } catch (error) {
      // The outer net. Everything below is already guarded, but this method is
      // on the sign-in path and "already guarded" is a claim about code that
      // will be edited by somebody who has not read this comment.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[sms:msg91] ${describe(request.template)} failed unexpectedly: ${detail}`,
      );
      return {
        ok: false,
        retryable: true,
        message: "the provider call failed unexpectedly",
      };
    }
  }

  private async attempt(request: SmsRequest): Promise<SmsResult> {
    // The env is read at SEND time, not captured at import. `templates.ts` takes
    // its copy when the module first loads, which is right for a long-running
    // server and wrong for anything that sets the id after boot — a test, or a
    // process that reloads configuration. The registered id stays the same value
    // from the same variable either way.
    const templateId = (
      process.env[`SMS_TEMPLATE_${request.template}`] ??
      TEMPLATES[request.template].dltTemplateId
    ).trim();

    // Refused here, before a request is made, because this is the failure that
    // does not announce itself. A message with no registered template id is
    // dropped by the OPERATOR, at the network — after MSG91 has accepted it and
    // answered success. The ledger would record a send that never happened.
    if (!templateId) {
      console.error(
        `[sms:msg91] refused ${describe(request.template)}: no DLT template id is configured`,
      );
      return {
        ok: false,
        retryable: false,
        message: "no DLT template id is configured for this message",
      };
    }
    if (!this.authKey || !this.senderId) {
      console.error(
        `[sms:msg91] refused ${describe(request.template)}: SMS_API_KEY or SMS_SENDER_ID is not set`,
      );
      return {
        ok: false,
        retryable: false,
        message: "the provider is selected but not configured",
      };
    }

    const recipient: Record<string, string> = {
      mobiles: `${COUNTRY_CODE}${request.phone}`,
    };
    // VAR1..VARn, which is the naming MSG91's documentation uses and the naming
    // their template editor defaults to. It is CASE-SENSITIVE and has to match
    // the names the template was actually registered under, which is a fact
    // about somebody's DLT paperwork rather than about this code — so the names
    // are overridable per template without a deploy.
    variableNames(request.template, request.variables.length).forEach(
      (name, index) => {
        recipient[name] = request.variables[index] ?? "";
      },
    );

    const body = JSON.stringify({
      // Their published reference calls this `flow_id`; their current console
      // and help pages call the same value `template_id` and say plainly that
      // the template id IS the flow id. Both are sent, with one value, because
      // the cost of sending the redundant one is nothing and the cost of
      // picking the wrong one is a message that is never registered and
      // therefore never arrives.
      flow_id: templateId,
      template_id: templateId,
      sender: this.senderId,
      recipients: [recipient],
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authkey: this.authKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[sms:msg91] ${describe(request.template)} could not reach the provider: ${detail}`,
      );
      return {
        ok: false,
        retryable: true,
        message: aborted
          ? `the provider did not answer within ${this.timeoutMs}ms`
          : "the provider could not be reached",
      };
    } finally {
      clearTimeout(timer);
    }

    return this.readResponse(request, response);
  }

  private async readResponse(
    request: SmsRequest,
    response: Response,
  ): Promise<SmsResult> {
    // Text first. A gateway in front of MSG91 answering with an HTML error page
    // is a real thing, and `response.json()` on one throws — which would take
    // the classification with it and lose the difference between "rejected" and
    // "we never found out".
    let text: string;
    try {
      text = await response.text();
    } catch {
      return this.unknown(request, response.status, "the response body could not be read");
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }

    const payload = asPayload(parsed);

    if (payload?.type === "success") {
      // Their documented success shape puts the id in `message`. It is a
      // request id, not proof a handset rang — but it is the one string a
      // support call can hand back to MSG91 to ask, so it is what the ledger
      // stores. Accepted for delivery, which is not the same as delivered, and
      // the ledger's own status word (SENT) already means the former.
      const providerMessageId =
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : null;
      // v5/flow returns no price, and inventing one would be worse than a null
      // in a column somebody might later average.
      return { ok: true, providerMessageId, costMicros: null };
    }

    if (payload?.type === "error") {
      // Rejected. The provider read the request, understood it, and said no —
      // a different fact to a support call than a timeout, and the one case
      // where we know for certain nothing was sent.
      const code = payload.code ?? null;
      console.error(
        `[sms:msg91] ${describe(request.template)} was rejected (HTTP ${response.status}${
          code ? `, code ${code}` : ""
        }): ${payload.message ?? "no message"}`,
      );
      return {
        ok: false,
        retryable: code ? !PERMANENT_CODES.has(code) : false,
        message: rejection(code),
      };
    }

    if (response.status === 429 || response.status >= 500) {
      console.error(
        `[sms:msg91] ${describe(request.template)}: provider answered HTTP ${response.status}`,
      );
      return {
        ok: false,
        retryable: true,
        message: `the provider answered HTTP ${response.status}`,
      };
    }

    return this.unknown(
      request,
      response.status,
      parsed === null
        ? "the provider's answer was not JSON"
        : "the provider's answer was not a shape this adapter knows",
    );
  }

  /**
   * Neither accepted nor rejected.
   *
   * Reported as a failure, because claiming a send we cannot evidence is the
   * exact lie this layer exists to avoid — and as RETRYABLE, because "we did
   * not find out" is not "they said no", and telling somebody that pressing
   * the button again is futile when it might work is the wrong way round.
   */
  private unknown(
    request: SmsRequest,
    status: number,
    why: string,
  ): SmsResult {
    console.error(`[sms:msg91] ${describe(request.template)}: HTTP ${status}, ${why}`);
    return { ok: false, retryable: true, message: why };
  }
}

/** Our sentence for their code. Never theirs. */
function rejection(code: string | null): string {
  if (!code) return "the provider rejected the request";
  const meaning = CODE_MEANING[code];
  return meaning
    ? `the provider rejected it: ${meaning} (code ${code})`
    : `the provider rejected it (code ${code})`;
}

/**
 * The variable names this template was registered under.
 *
 * Defaults to VAR1..VARn — MSG91's documented naming — and can be overridden
 * per template, because the real names live in a DLT registration somebody
 * filed and not in this repository. Positional, matching `SmsRequest.variables`
 * and the template's declared arity.
 */
function variableNames(key: SmsRequest["template"], count: number): string[] {
  const configured = (process.env[`SMS_TEMPLATE_${key}_VARS`] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (configured.length === count) return configured;
  return Array.from({ length: count }, (_, index) => `VAR${index + 1}`);
}

type Msg91Payload = {
  type?: string;
  message?: string;
  code?: string;
};

function asPayload(value: unknown): Msg91Payload | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
  const message = typeof record.message === "string" ? record.message : undefined;
  // Documented as a string ("106"), seen as a number in the wild. Normalised
  // rather than trusted, so a numeric code still matches the permanent set.
  const code =
    typeof record.code === "string"
      ? record.code
      : typeof record.code === "number"
        ? String(record.code)
        : undefined;
  if (!type) return null;
  return { type, message, code };
}
