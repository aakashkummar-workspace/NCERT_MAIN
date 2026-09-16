/**
 * The internationalisation seam.
 *
 * Everything exported here is isomorphic — no `next/headers`, no `server-only`,
 * no database — so a client component and a server component import the same
 * `t()` and get the same string. `./server` is deliberately NOT re-exported:
 * it reads the request, and pulling it into a client bundle would turn a
 * missing translation into a build error about a server module.
 *
 * ---------------------------------------------------------------------------
 * What this seam does not do, and will not
 * ---------------------------------------------------------------------------
 * It translates the INTERFACE. It does not translate the CURRICULUM. Questions,
 * options, explanations, chapter names, learning-outcome statements and concept
 * names are authored by teachers in English, live on the shared curriculum
 * plane which has no locale column and no tenant, and are frozen by version
 * when a paper is published. A student who switches to Hindi gets Hindi
 * buttons, labels, errors and dates, and English questions.
 *
 * That is a real limitation and it is the honest one. Machine-translating a
 * CBSE question would produce a paper that marks differently from the one the
 * teacher approved, on a plane where "Mathematics" is deliberately the same row
 * for every school in the country. A Hindi question bank is an authoring
 * project — somebody who teaches the subject writes it, and it goes through the
 * same validator, the same approval and the same immutability rules as any
 * other question. Nothing in this folder is a step towards it, and nothing here
 * should be built to look like one.
 */

export { CATALOGS, FALLBACK_LOCALE } from "./catalog";
export type {
  Catalog,
  KeyWithoutValues,
  Message,
  MessageKey,
  MessageParams,
  MessageValues,
  PluralMessage,
} from "./catalog";

export {
  APP_CURRENCY,
  APP_TIME_ZONE,
  FORMAT_FALLBACK_LOCALE,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatTime,
} from "./format";

export {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAME,
  htmlLang,
  isLocale,
} from "./locales";
export type { Locale } from "./locales";

export {
  matchAcceptLanguage,
  resolveLocale,
  resolveLocaleWithSource,
} from "./resolve";
export type { LocaleResolution, LocaleSources } from "./resolve";

export { createTranslator, pluralCategory, selectPlural, translate } from "./translate";
export type { Translator } from "./translate";
