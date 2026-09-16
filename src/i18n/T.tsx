"use client";

import { FALLBACK_LOCALE, type KeyWithoutValues } from "./catalog";
import { useLocale } from "./LocaleContext";
import { translate } from "./translate";

/**
 * One translated string, in the locale the surrounding layout resolved.
 *
 * For server components that are shared by many pages — the student shell —
 * and so cannot be handed a locale by each of them. It renders a bare string
 * during the server pass exactly as it does in the browser, so there is no
 * flash of English: the provider's value is the same on both sides.
 *
 * Keys with placeholders are deliberately not accepted. A sentence with a
 * value in it belongs to a page that has the value and the locale together,
 * and can call `createTranslator` itself.
 */
export function T({ k }: { k: KeyWithoutValues }) {
  const locale = useLocale();
  const text = translate(locale, k);
  // The document says `en-IN` (the root layout), so a string in any other
  // language carries its own `lang` — otherwise a screen reader pronounces
  // Devanagari with an English voice, which is unusable rather than wrong.
  return locale === FALLBACK_LOCALE ? <>{text}</> : <span lang={locale}>{text}</span>;
}
