import { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from "./locales";

/**
 * Which language to render in.
 *
 * ---------------------------------------------------------------------------
 * The precedence, and it is not arbitrary
 * ---------------------------------------------------------------------------
 *   1. `User.locale` — what this person chose, stored against their account.
 *   2. `Accept-Language` — what the handset was set up in.
 *   3. `en-IN`.
 *
 * The stored preference beats the header, always, and the reason is the
 * handset this product actually runs on. A large share of our students sign in
 * on a phone that is not theirs: a parent's, an older sibling's, the one phone
 * the family owns. `Accept-Language` on that phone describes whoever set it up
 * — often years ago, often in English because that is what the shop configured
 * — and it does not change when a different person signs in. So a header that
 * outranked the stored choice would take a student who deliberately switched
 * to Hindi and put them back into English at the next sign-in, on a device
 * setting they cannot find and would not think to look for. The setting would
 * appear to be broken, which is worse than not having one.
 *
 * The header is still the SECOND rung rather than being ignored, because a
 * student's very first screen is the sign-in form and there is no account to
 * read a preference from yet. A phone configured in Hindi is the best evidence
 * available at that moment, and it is better evidence than a default.
 *
 * ---------------------------------------------------------------------------
 * Pure, and it takes values rather than fetching them
 * ---------------------------------------------------------------------------
 * `src/i18n` may not import `@/core` or `@/app` — the layering rule in
 * CLAUDE.md — so this function cannot open a session or read a request. It
 * takes the stored string and the header string, which is also what makes the
 * precedence testable without a database, a browser or a running server.
 */

export type LocaleSources = {
  /**
   * `User.locale` for the signed-in user, or null when nobody is signed in.
   *
   * Typed as `string | null | undefined` rather than `Locale`, because it is a
   * free-text column: it can hold a tag this build has never heard of — a
   * language that shipped and was rolled back, or a row written by a script.
   * An unrecognised value falls through to the header instead of throwing.
   */
  stored?: string | null;
  /** The raw `Accept-Language` request header. */
  acceptLanguage?: string | null;
};

export type LocaleResolution = {
  locale: Locale;
  /**
   * Which rung answered. Not decoration: it is the difference between "you
   * chose this" and "we guessed from your phone", and a language switcher that
   * cannot tell them apart cannot offer the guess for confirmation.
   */
  source: "stored" | "header" | "default";
};

export function resolveLocaleWithSource(
  sources: LocaleSources,
): LocaleResolution {
  if (isLocale(sources.stored)) {
    return { locale: sources.stored, source: "stored" };
  }

  const fromHeader = matchAcceptLanguage(sources.acceptLanguage);
  if (fromHeader) return { locale: fromHeader, source: "header" };

  return { locale: DEFAULT_LOCALE, source: "default" };
}

export function resolveLocale(sources: LocaleSources): Locale {
  return resolveLocaleWithSource(sources).locale;
}

/**
 * The best supported locale named by an `Accept-Language` header, or null.
 *
 * Handles the two things real headers do that a naive `split(",")[0]` gets
 * wrong: quality values are not in header order (Chrome sends
 * `hi-IN,hi;q=0.9,en-US;q=0.8`, but a user can reorder their languages so the
 * first entry is not the preferred one), and a client may name a bare language
 * with no region. `hi` is a request for Hindi and we have exactly one Hindi
 * catalog, so it matches `hi-IN`; refusing it because the region is absent
 * would send a Hindi speaker an English page over a formatting detail.
 *
 * `q=0` is not "least preferred". It is "do not send me this", so it is
 * dropped rather than sorted last.
 */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;

  const entries: { tag: string; quality: number }[] = [];

  for (const part of header.split(",")) {
    const [rawTag, ...parameters] = part.trim().split(";");
    const tag = rawTag?.trim().toLowerCase();
    if (!tag || tag === "*") continue;

    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(parameter);
      if (!match?.[1]) continue;
      const parsed = Number.parseFloat(match[1]);
      if (Number.isFinite(parsed)) quality = parsed;
    }

    if (quality <= 0) continue;
    entries.push({ tag, quality });
  }

  // Stable by specification since ES2019, so equal qualities keep header order
  // — which is the order the user put their languages in.
  entries.sort((a, b) => b.quality - a.quality);

  for (const entry of entries) {
    const exact = LOCALES.find((locale) => locale.toLowerCase() === entry.tag);
    if (exact) return exact;

    const base = entry.tag.split("-")[0];
    if (!base) continue;
    const byLanguage = LOCALES.find(
      (locale) => locale.split("-")[0]?.toLowerCase() === base,
    );
    if (byLanguage) return byLanguage;
  }

  return null;
}
