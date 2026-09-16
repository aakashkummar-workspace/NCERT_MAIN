import { DEFAULT_LOCALE, type Locale } from "./locales";

/**
 * Numbers, money, dates and times — through `Intl`, and through nothing else.
 *
 * ---------------------------------------------------------------------------
 * No formatting library
 * ---------------------------------------------------------------------------
 * `Intl` ships with the runtime and already knows the two things about India
 * that a hand-rolled formatter gets wrong: the digit grouping is 12,34,567 and
 * not 1,234,567, and the date is day-first. A dependency would add a megabyte
 * to a student's 3G page load to re-derive data the engine is already holding.
 *
 * ---------------------------------------------------------------------------
 * The time zone is pinned, and that is a correctness fix, not a preference
 * ---------------------------------------------------------------------------
 * `Intl.DateTimeFormat` with no `timeZone` uses the HOST's zone. The host is a
 * server, and servers run on UTC. A test window that closes at 00:30 IST would
 * render on the server as the previous day at 19:00 — so a student is told the
 * paper is due Tuesday and their teacher, whose browser is in IST, is looking
 * at Wednesday. Every timestamp in this product is a school timestamp in one
 * country, so the zone is a constant.
 *
 * ---------------------------------------------------------------------------
 * India-only, deliberately under-built
 * ---------------------------------------------------------------------------
 * The currency is INR with no parameter to change it, and the calendar is
 * whatever `Intl` resolves for these two locales, which is Gregorian for both.
 * A `currency` argument would be a knob for a market we do not sell in, and
 * the first bug it produces is somebody passing "USD" from a copied line. When
 * this product sells outside India, that is a pricing project — not a
 * formatting one — and the argument can be added then.
 */

/** Every timestamp this product shows belongs to a school day in India. */
export const APP_TIME_ZONE = "Asia/Kolkata";

/** The only currency, for the same reason. */
export const APP_CURRENCY = "INR";

/**
 * Constructing an `Intl` formatter is expensive — it resolves locale data on
 * every call — and a results table builds one per cell if you let it. Cached
 * by locale and options, which is the documented way to use these.
 */
const numberFormatters = new Map<string, Intl.NumberFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function numberFormatter(
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options ?? null)}`;
  const cached = numberFormatters.get(key);
  if (cached) return cached;
  const made = new Intl.NumberFormat(locale, options);
  numberFormatters.set(key, made);
  return made;
}

function dateFormatter(
  locale: Locale,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  const cached = dateFormatters.get(key);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat(locale, {
    timeZone: APP_TIME_ZONE,
    ...options,
  });
  dateFormatters.set(key, made);
  return made;
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormatter(locale, options).format(value);
}

/**
 * A fraction in 0..1 as a percentage — the shape every mastery and score
 * figure in this product already has.
 *
 * It takes the fraction rather than the percentage on purpose: a function that
 * accepted 62 and one that accepted 0.62 would eventually both exist, and the
 * bug that produces is a mastery estimate rendered as 0% or 6200%.
 */
export function formatPercent(
  locale: Locale,
  fraction: number,
  maximumFractionDigits = 0,
): string {
  return numberFormatter(locale, {
    style: "percent",
    maximumFractionDigits,
  }).format(fraction);
}

/**
 * Money, in paise.
 *
 * Paise because that is what `plans.price_paise` stores, and money in a
 * floating-point rupee is money that eventually renders as ₹1,298.9999999. The
 * conversion happens here, once, at the edge where it becomes text.
 */
export function formatMoney(locale: Locale, paise: number): string {
  return numberFormatter(locale, {
    style: "currency",
    currency: APP_CURRENCY,
  }).format(paise / 100);
}

export function formatDate(
  locale: Locale,
  value: Date | number,
  dateStyle: "full" | "long" | "medium" | "short" = "medium",
): string {
  return dateFormatter(locale, { dateStyle }).format(value);
}

export function formatTime(
  locale: Locale,
  value: Date | number,
  timeStyle: "medium" | "short" = "short",
): string {
  return dateFormatter(locale, { timeStyle }).format(value);
}

export function formatDateTime(
  locale: Locale,
  value: Date | number,
  dateStyle: "long" | "medium" | "short" = "medium",
  timeStyle: "medium" | "short" = "short",
): string {
  return dateFormatter(locale, { dateStyle, timeStyle }).format(value);
}

/**
 * The locale a formatter falls back to when the caller has none.
 *
 * Exported so a call site that has genuinely not resolved a locale yet — a
 * script, a log line — has one obvious answer rather than each writing its own
 * `?? "en-IN"`.
 */
export const FORMAT_FALLBACK_LOCALE: Locale = DEFAULT_LOCALE;
