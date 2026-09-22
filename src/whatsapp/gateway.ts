import "server-only";
import { configuredProvider, hasMetaCredentials, type WhatsappProvider } from "./provider";
import { MetaWhatsappProvider } from "./meta";
import { buildParameters, render, type WhatsappTemplateKey } from "./templates";

/**
 * The only door to WhatsApp. It never throws — a digest that fails to send is
 * a line in the ledger, never an error in a job that is sending to a hundred
 * other parents. Recording the attempt is the caller's job (core/digest),
 * because the ledger is a tenant table and the caller holds the tenant.
 */

const MOBILE = /^[6-9]\d{9}$/;

class LogWhatsappProvider implements WhatsappProvider {
  readonly name = "log";
  async send(request: Parameters<WhatsappProvider["send"]>[0]) {
    console.log(`[whatsapp] to ${request.to.slice(0, 4)}…${request.to.slice(-2)}:\n${render(request.template, request.parameters)}`);
    return { ok: true as const, providerMessageId: null };
  }
}

let cached: WhatsappProvider | null | undefined;

function provider(): WhatsappProvider | null {
  if (cached !== undefined) return cached;
  const named = configuredProvider();
  cached =
    named === "log"
      ? new LogWhatsappProvider()
      : named === "meta" && hasMetaCredentials()
        ? new MetaWhatsappProvider()
        : null;
  return cached;
}

/** Tests replace the provider; nothing else should. */
export function setWhatsappProvider(next: WhatsappProvider | null | undefined): void {
  cached = next;
}

export function whatsappConfigured(): boolean {
  return provider() !== null;
}

export type WhatsappOutcome =
  | { ok: true; provider: string; providerMessageId: string | null }
  | { ok: false; provider: string | null; reason: "not-configured" | "invalid-number" | "provider"; detail: string };

export async function sendWhatsapp(input: {
  phone: string;
  template: WhatsappTemplateKey;
  values: string[];
}): Promise<WhatsappOutcome> {
  const phone = input.phone.trim();
  if (!MOBILE.test(phone)) {
    return { ok: false, provider: null, reason: "invalid-number", detail: "not an Indian mobile number" };
  }
  const chosen = provider();
  if (!chosen) {
    return { ok: false, provider: null, reason: "not-configured", detail: "no WhatsApp provider is configured" };
  }
  let parameters: string[];
  try {
    parameters = buildParameters(input.template, input.values);
  } catch (error) {
    return { ok: false, provider: chosen.name, reason: "provider", detail: String(error) };
  }
  const result = await chosen.send({ to: `91${phone}`, template: input.template, parameters });
  if (!result.ok) {
    // The vendor's words go to the log, never to a person.
    console.error(`[whatsapp] ${input.template} failed: ${result.error}`);
    return { ok: false, provider: chosen.name, reason: "provider", detail: result.error };
  }
  return { ok: true, provider: chosen.name, providerMessageId: result.providerMessageId };
}
