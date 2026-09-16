import type { Locale } from "./locales";
import { en } from "./messages/en-IN";
import { hi } from "./messages/hi-IN";

/**
 * The catalog contract, derived from the English catalog rather than declared.
 *
 * ---------------------------------------------------------------------------
 * Why a missing key has to be a compile error
 * ---------------------------------------------------------------------------
 * The runtime failure mode of a missing translation is not an error message.
 * It is `<p></p>` — an element with nothing in it, in a language the person
 * who shipped it does not read, on a screen they will never open. Nobody
 * notices until a user does, and a user who cannot read the button does not
 * file a bug, they leave.
 *
 * So the check moves to the compiler. `MessageKey` is `keyof typeof en`, and
 * `Catalog` maps every one of those keys to the SHAPE the English entry has —
 * a plain string stays a plain string, a plural set stays a plural set. Any
 * catalog declared `satisfies Catalog` therefore fails to build if it is
 * missing a key, has a stray key, or writes a plural message as a single
 * string. There is no lint rule to remember and no key-parity test to keep in
 * sync; `tsc` is the check, and `npm run verify` already runs it.
 */

/**
 * A message with one form per CLDR plural category.
 *
 * `other` is required and the rest are optional, because that is exactly the
 * guarantee CLDR gives: every locale has `other`, and which of the remaining
 * five it uses is the locale's business, not the translator's. A catalog that
 * required all six would make an English translator invent a Hindi "few".
 */
export type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & {
  other: string;
};

export type Message = string | PluralMessage;

/** Every message the interface can render. Adding one here is adding work. */
export type MessageKey = keyof typeof en;

export type Catalog = {
  readonly [K in MessageKey]: (typeof en)[K] extends string
    ? string
    : PluralMessage;
};

export const CATALOGS: Record<Locale, Catalog> = {
  "en-IN": en,
  "hi-IN": hi,
};

/**
 * The locale every other catalog falls back to when a lookup misses at
 * runtime. English, because it is the catalog the keys are derived from and so
 * the only one that cannot itself be incomplete.
 */
export const FALLBACK_LOCALE: Locale = "en-IN";

/* ------------------------------------------------------ interpolation types */

/**
 * The placeholder names inside a message, pulled out of the string literal.
 *
 * This is what makes `t("signin.dev.notice")` — with the `{code}` value
 * forgotten — a compile error rather than a screen that reads "your code is
 * {code}". The English catalog is `as const`, so its values are literal types
 * and the template-literal inference below has something to read.
 */
type PlaceholderNames<S extends string> =
  S extends `${string}{${infer Name}}${infer Rest}`
    ? Name | PlaceholderNames<Rest>
    : never;

type OtherForm<M> = M extends { other: infer O }
  ? O extends string
    ? O
    : never
  : never;

/**
 * The values a given key needs. A plural message always needs `count` — that
 * is the number the CLDR category is selected from — plus whatever its `other`
 * form interpolates.
 */
export type MessageParams<K extends MessageKey> = (typeof en)[K] extends string
  ? PlaceholderNames<(typeof en)[K]>
  : "count" | PlaceholderNames<OtherForm<(typeof en)[K]>>;

export type MessageValues<K extends MessageKey> = {
  [P in MessageParams<K>]: P extends "count" ? number : string | number;
};

/**
 * The keys that take no values at all.
 *
 * Nothing to interpolate means no second argument, rather than an empty object:
 * `t("signin.title")` is what a component author expects to write, and a seam
 * that made them write `t("signin.title", {})` would get wrapped in a helper
 * within a week.
 *
 * It is a named type rather than a conditional rest tuple on `t()` because of
 * the ERROR MESSAGE. With one signature, a mistyped key infers `K` as the whole
 * union, which changes the arity requirement underneath the call — and
 * TypeScript then reports "Expected 3 arguments, but got 2" while saying
 * nothing about the typo that caused it. Two overloads put the key back in the
 * message. An error nobody can read is most of the way to no error at all.
 */
export type KeyWithoutValues = {
  [K in MessageKey]: [MessageParams<K>] extends [never] ? K : never;
}[MessageKey];
