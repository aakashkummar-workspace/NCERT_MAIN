/**
 * The locales this product ships, and the tags everything else agrees on.
 *
 * ---------------------------------------------------------------------------
 * Two, not "any"
 * ---------------------------------------------------------------------------
 * A `Locale` is a closed union, not `string`. Every other module in this folder
 * keys off it — the catalogs, the formatter cache, the resolver — so adding a
 * third language is one entry here plus a catalog the compiler will not let you
 * leave half-written. An open `string` would make each of those a runtime
 * lookup that can miss, and a missed lookup in an interface renders as nothing
 * at all.
 *
 * ---------------------------------------------------------------------------
 * Region-qualified, deliberately
 * ---------------------------------------------------------------------------
 * `en-IN` rather than `en`, `hi-IN` rather than `hi`. This product is sold in
 * one country, and the region is what carries the two formatting decisions that
 * actually show up on screen: the Indian digit grouping (12,34,567 — not
 * 1,234,567) and day-first dates. A bare `en` resolves to `en-US` conventions
 * in most engines, which would print a lakh wrong and a date ambiguously, on
 * every screen, forever.
 */

/** Every locale the interface is translated into. */
export const LOCALES = ["en-IN", "hi-IN"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * The last rung of the resolver, and the value of `User.locale`'s column
 * default in `prisma/schema.prisma`. The two must agree: a stored default of
 * "en-IN" that this module did not recognise would silently take every user
 * down the fallback path.
 */
export const DEFAULT_LOCALE: Locale = "en-IN";

/**
 * Names written in their own language.
 *
 * "Hindi" in an English list is the wrong way round: somebody who cannot read
 * the interface cannot read the label that would let them change it either. A
 * language switcher shows हिन्दी.
 */
export const LOCALE_NAME: Record<Locale, string> = {
  "en-IN": "English",
  "hi-IN": "हिन्दी",
};

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

/**
 * The value for `<html lang>`.
 *
 * Identical to the locale tag today, and it stays a function rather than a
 * property read because the two are different things and will eventually
 * disagree: a locale is a formatting preference, `lang` is a statement about
 * the text a screen reader is about to pronounce. A screen reader handed
 * `lang="en-IN"` on Devanagari text reads it as English, which is unusable
 * rather than merely wrong.
 */
export function htmlLang(locale: Locale): string {
  return locale;
}
