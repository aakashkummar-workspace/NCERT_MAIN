import {
  CATALOGS,
  FALLBACK_LOCALE,
  type KeyWithoutValues,
  type Message,
  type MessageKey,
  type MessageValues,
  type PluralMessage,
} from "./catalog";
import { formatNumber } from "./format";
import type { Locale } from "./locales";

/**
 * `t()` — the seam every rendered string goes through.
 *
 * ---------------------------------------------------------------------------
 * Type-safe first, translated second
 * ---------------------------------------------------------------------------
 * `translate` is generic over `MessageKey`, so a key that does not exist, a key
 * that was renamed, and a `{placeholder}` whose value was forgotten are all
 * build failures naming the key. That ordering is the point of the whole file:
 * the failure mode of a string lookup is silence — an element with nothing in
 * it — and silence in a language the team does not read is indistinguishable
 * from a page that is fine. `npm run verify` already runs `tsc`, so the check
 * costs nothing and cannot be skipped.
 *
 * ---------------------------------------------------------------------------
 * Plurals go through Intl.PluralRules, never through `count === 1`
 * ---------------------------------------------------------------------------
 * English has two cardinal forms and picks the singular at exactly 1. Hindi
 * also has two — and picks the SINGULAR AT ZERO as well as at one. So
 * `count === 1 ? singular : plural` is not a shortcut that happens to work for
 * a while; it is wrong for every zero in the Hindi build, which is the most
 * common count an empty list ever has. Ask CLDR, which knows this for every
 * language including the ones with four and six forms, and the same code is
 * correct for the third language nobody has planned yet.
 */

const pluralRules = new Map<Locale, Intl.PluralRules>();

/**
 * The CLDR plural category for a count in a locale.
 *
 * Exported because it is the claim this file makes about the world, and a
 * claim about the world belongs in a test: `pluralCategory("hi-IN", 0)` is
 * "one" and `pluralCategory("en-IN", 0)` is "other".
 */
export function pluralCategory(
  locale: Locale,
  count: number,
): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * Picks a form, falling back to `other`.
 *
 * The fallback here is not a failure and is deliberately silent: CLDR
 * guarantees `other` exists for every locale, and a catalog that omits `few`
 * for a locale that never selects `few` is complete, not broken. Being loud
 * about it would train everyone to ignore the loud thing.
 */
export function selectPlural(
  locale: Locale,
  message: PluralMessage,
  count: number,
): string {
  return message[pluralCategory(locale, count)] ?? message.other;
}

/* ------------------------------------------------------------- the fallback */

const isProduction = process.env.NODE_ENV === "production";

/**
 * What happens when a lookup misses at runtime.
 *
 * The types above mean this should be unreachable — a miss needs a cast, a
 * catalog loaded from outside the build, or a key composed at runtime. Which
 * is exactly why the two environments get opposite treatment:
 *
 *   - In DEVELOPMENT it throws. The person who can fix it is at the keyboard,
 *     and an exception naming the locale and the key cannot be scrolled past.
 *     A console warning can, and is.
 *   - In PRODUCTION it logs and returns the ENGLISH string. A student reading
 *     one English label in an otherwise Hindi form has a slightly worse page;
 *     the same student reading a blank button has no page. Crashing a sign-in
 *     screen because a translator missed a word is a self-inflicted outage,
 *     and nothing on this path is worth one.
 */
function reportMissing(locale: Locale, key: string): void {
  const detail = `i18n: no message for "${key}" in ${locale}`;
  if (!isProduction) throw new Error(detail);
  console.error(detail);
}

function read(locale: Locale, key: MessageKey): Message | undefined {
  // The cast is the honest one: `Catalog` promises the key exists, and this
  // function is the place that stops believing it.
  return CATALOGS[locale][key] as Message | undefined;
}

function resolveMessage(locale: Locale, key: MessageKey): Message {
  const found = read(locale, key);
  if (found !== undefined) return found;

  reportMissing(locale, key);

  // Production only — `reportMissing` has already thrown in development.
  const english = read(FALLBACK_LOCALE, key);
  if (english !== undefined) return english;

  // Not even English has it, so the key was invented at runtime. The key is a
  // worse string than a translation and a much better one than "".
  return key;
}

/* ---------------------------------------------------------- interpolation -- */

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Substitutes `{name}` tokens.
 *
 * Numbers go through `Intl` on the way in, so `{count}` in a Hindi sentence is
 * grouped the Indian way without every call site remembering to format it
 * first. Strings are inserted as they are — a phone number is not a number,
 * and grouping one would be nonsense.
 *
 * A value that was not supplied leaves its token on screen rather than
 * disappearing. That is deliberate and it is the same argument as the missing
 * key: an empty gap in a sentence is invisible to everyone including the
 * reader, while a visible `{code}` is something a student can quote in a
 * support message and somebody can grep for.
 */
function interpolate(
  locale: Locale,
  key: MessageKey,
  template: string,
  values: Record<string, string | number> | undefined,
): string {
  return template.replace(PLACEHOLDER, (token, name: string) => {
    const value = values?.[name];
    if (value === undefined) {
      const detail = `i18n: no value for "{${name}}" in "${key}" (${locale})`;
      if (!isProduction) throw new Error(detail);
      console.error(detail);
      return token;
    }
    return typeof value === "number" ? formatNumber(locale, value) : value;
  });
}

/* -------------------------------------------------------------------- t() -- */

/**
 * Two overloads, one implementation.
 *
 * The split is for the error message, not for the behaviour: a key with no
 * placeholders takes no second argument, a key with placeholders requires
 * exactly its own values, and a MISTYPED key is reported as a mistyped key
 * rather than as an argument count. See `KeyWithoutValues` in `catalog.ts`.
 */
export function translate<K extends KeyWithoutValues>(
  locale: Locale,
  key: K,
): string;
export function translate<K extends MessageKey>(
  locale: Locale,
  key: K,
  values: MessageValues<K>,
): string;
export function translate(
  locale: Locale,
  key: MessageKey,
  values?: Record<string, string | number>,
): string {
  const message = resolveMessage(locale, key);

  const template =
    typeof message === "string"
      ? message
      : selectPlural(locale, message, Number(values?.["count"] ?? 0));

  return interpolate(locale, key, template, values);
}

/**
 * A `t` bound to one locale.
 *
 * Components get this rather than the three-argument form, because a component
 * that has to pass the locale on every line will eventually pass the wrong one
 * — and the wrong one is not a crash, it is an English word in a Hindi
 * paragraph that nobody reviewing the diff can see.
 */
export interface Translator {
  <K extends KeyWithoutValues>(key: K): string;
  <K extends MessageKey>(key: K, values: MessageValues<K>): string;
}

/** The implementation's own shape, behind the two public call signatures. */
type UntypedTranslate = (
  locale: Locale,
  key: MessageKey,
  values?: Record<string, string | number>,
) => string;

export function createTranslator(locale: Locale): Translator {
  // Overloads describe a call site; they do not describe a forwarding
  // function. The two casts are the cost of that, and they are confined to
  // these three lines rather than spread across every component.
  const bound = (key: MessageKey, values?: Record<string, string | number>) =>
    (translate as UntypedTranslate)(locale, key, values);
  return bound as Translator;
}
