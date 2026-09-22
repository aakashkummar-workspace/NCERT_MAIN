import "server-only";
import { WHATSAPP_TEMPLATES } from "./templates";
import type { WhatsappProvider, WhatsappRequest, WhatsappResult } from "./provider";

/**
 * WhatsApp Cloud API (Meta). The only file that knows its URL and shape.
 * Template messages only — a business may not start a free-text conversation.
 */
const GRAPH = "https://graph.facebook.com/v21.0";

export class MetaWhatsappProvider implements WhatsappProvider {
  readonly name = "meta";

  constructor(
    private readonly token = process.env.WHATSAPP_TOKEN ?? "",
    private readonly phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  ) {}

  async send(request: WhatsappRequest): Promise<WhatsappResult> {
    const template = WHATSAPP_TEMPLATES[request.template];
    try {
      const response = await fetch(`${GRAPH}/${this.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: request.to,
          type: "template",
          template: {
            name: template.name,
            language: { code: template.language },
            components: [
              {
                type: "body",
                parameters: request.parameters.map((text) => ({ type: "text", text })),
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => null)) as {
        messages?: { id?: string }[];
        error?: { message?: string; code?: number };
      } | null;
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}: ${body?.error?.message ?? "no detail"}` };
      }
      return { ok: true, providerMessageId: body?.messages?.[0]?.id ?? null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
