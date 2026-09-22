import type { WhatsappTemplateKey } from "./templates";

/**
 * The provider seam. Business code names a TEMPLATE; only this directory
 * names a vendor — the shape `src/sms` and `src/ai` already have.
 */
export type WhatsappRequest = {
  /** 91XXXXXXXXXX: country code, no plus, no spaces. */
  to: string;
  template: WhatsappTemplateKey;
  parameters: string[];
};

export type WhatsappResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string };

export interface WhatsappProvider {
  readonly name: string;
  send(request: WhatsappRequest): Promise<WhatsappResult>;
}

/** "none" is a real state and the default: this product has no WhatsApp account yet. */
export function configuredProvider(env = process.env): "none" | "log" | "meta" | string {
  return (env.WHATSAPP_PROVIDER ?? "none").trim().toLowerCase();
}

export function hasMetaCredentials(env = process.env): boolean {
  return Boolean(env.WHATSAPP_TOKEN?.trim() && env.WHATSAPP_PHONE_NUMBER_ID?.trim());
}
