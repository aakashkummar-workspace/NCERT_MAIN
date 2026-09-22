/**
 * The WhatsApp templates this product sends, and ONLY these.
 *
 * WhatsApp Business delivers a message a business starts only if it matches a
 * template Meta has approved, word for word. So the text lives here beside
 * the name it is registered under, and changing a word means registering it
 * again — the SMS/DLT rule. `buildParameters` throws on the wrong number of
 * variables rather than padding: a mismatched template is a message that is
 * rejected and never explained.
 *
 * Variables must be one line each (WhatsApp refuses newlines in a parameter)
 * and are cut to a safe length.
 */

export type WhatsappTemplateKey = "WEEKLY_DIGEST";

export const WHATSAPP_TEMPLATES: Record<
  WhatsappTemplateKey,
  { name: string; language: string; variables: number; body: string }
> = {
  WEEKLY_DIGEST: {
    // Register exactly this, as a UTILITY template, language "en".
    name: "weekly_progress_digest",
    language: "en",
    variables: 4,
    body:
      "This week for {{1}}:\n\n" +
      "Results: {{2}}\n" +
      "Worth practising: {{3}}\n\n" +
      "See everything on the parent page: {{4}}\n\n" +
      "Reply STOP to stop these weekly messages.",
  },
};

const MAX_PARAMETER = 180;

export function buildParameters(key: WhatsappTemplateKey, values: string[]): string[] {
  const template = WHATSAPP_TEMPLATES[key];
  if (values.length !== template.variables) {
    throw new Error(
      `${template.name} takes ${template.variables} variables and was given ${values.length}.`,
    );
  }
  return values.map((value) => {
    const line = value.replace(/\s+/g, " ").trim();
    return line.length > MAX_PARAMETER ? `${line.slice(0, MAX_PARAMETER - 1)}…` : line || "—";
  });
}

/** The message as the parent would read it — for the log provider and tests. */
export function render(key: WhatsappTemplateKey, parameters: string[]): string {
  return parameters.reduce(
    (text, value, index) => text.replace(`{{${index + 1}}}`, value),
    WHATSAPP_TEMPLATES[key].body,
  );
}
