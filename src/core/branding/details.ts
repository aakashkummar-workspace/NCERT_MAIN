import { z } from "zod";

/**
 * The words a school puts on its own screens and documents.
 *
 * Pure, and shared by the editor and the route, so a field refused on save is
 * a field the form could have flagged while it was being typed.
 *
 * Every field is optional and an empty string means "not set". Lengths are
 * capped by where the text is drawn: a display name longer than about sixty
 * characters does not fit the sidebar, and a report footer of four paragraphs
 * pushes the sheet's own caveat onto a second page.
 */

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

export const MAX_SIGNATORIES = 3;

export const BrandingDetails = z.object({
  displayName: text(80),
  // The letters in the square mark when there is no logo. Two or three read;
  // five do not fit the mark at all.
  shortName: text(4),
  tagline: text(120),

  address: text(300),
  affiliationNumber: text(40),
  schoolCode: text(40),
  principalName: text(80),
  contactPhone: text(20),
  contactEmail: z
    .string()
    .trim()
    .max(120)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional()
    .refine(
      (value) => value === null || value === undefined || z.email().safeParse(value).success,
      "That does not look like an email address.",
    ),
  website: z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional()
    .refine(
      // https only, and parsed rather than pattern-matched: this becomes an
      // href on a sign-in page, and `javascript:` is a URL too.
      (value) => {
        if (value === null || value === undefined) return true;
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      },
      "Use the full address, starting https://",
    ),

  reportFooter: text(400),
  signatories: z
    .array(z.string().trim().min(1).max(60))
    .max(MAX_SIGNATORIES, `A sheet has room for ${MAX_SIGNATORIES} signature lines.`)
    .optional(),

  hidePoweredBy: z.boolean().optional(),
});

/**
 * "St. Mary's Convent School" → "MC".
 *
 * The mark is a square with room for two letters, and "St." is a word nobody
 * would put in a monogram. Here rather than in core/branding/index.ts because
 * the editor's preview draws the same mark, and a preview that computed it a
 * second way would disagree with the screen it previews.
 */
export function initials(name: string): string {
  const words = name
    // An apostrophe joins a word rather than ending one: "Mary's" is one word,
    // and splitting it put an "S" in the mark of every saint's school.
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0 && !/^(st|the|of|and|school|sr|sec)$/i.test(word));
  const letters = (words.length > 0 ? words : [name]).slice(0, 2).map((w) => w[0] ?? "");
  return letters.join("").toUpperCase() || "S";
}

export type BrandingDetailsInput = z.input<typeof BrandingDetails>;
export type BrandingDetailsValue = z.output<typeof BrandingDetails>;
