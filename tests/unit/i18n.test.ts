import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOGS,
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAME,
  createTranslator,
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  formatTime,
  htmlLang,
  isLocale,
  matchAcceptLanguage,
  pluralCategory,
  resolveLocale,
  resolveLocaleWithSource,
  translate,
  type Locale,
  type MessageKey,
} from "@/i18n";

/**
 * The i18n seam.
 *
 * Most of the guarantees in this folder are the compiler's, not these tests' —
 * a missing key and a forgotten `{placeholder}` are build failures, and a test
 * cannot assert something that will not compile. So what is tested here is the
 * part `tsc` cannot see: the precedence a human argued about, the CLDR
 * behaviour that makes `count === 1` wrong, the formatting that depends on ICU
 * knowing where India is, and the runtime fallback that only fires when
 * somebody has cast their way around the types.
 */

const DEVANAGARI = /[ऀ-ॿ]/;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------ the resolver */

describe("resolveLocale — precedence", () => {
  it("prefers the stored preference over the header", () => {
    // The case this rule exists for: a student who chose Hindi, signing in on
    // a family phone whose browser was set up in English by somebody else.
    expect(
      resolveLocale({ stored: "hi-IN", acceptLanguage: "en-GB,en;q=0.9" }),
    ).toBe("hi-IN");
  });

  it("uses the header when nobody is signed in", () => {
    expect(resolveLocale({ acceptLanguage: "hi-IN,hi;q=0.9,en;q=0.8" })).toBe(
      "hi-IN",
    );
  });

  it("falls back to en-IN when there is neither", () => {
    expect(resolveLocale({})).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ stored: null, acceptLanguage: null })).toBe("en-IN");
  });

  it("ignores a stored value this build does not recognise", () => {
    // `User.locale` is a free-text column. A tag from a language that shipped
    // and was rolled back must degrade to the next rung, not throw on a page
    // somebody is trying to sign in from.
    expect(
      resolveLocale({ stored: "ta-IN", acceptLanguage: "hi-IN" }),
    ).toBe("hi-IN");
    expect(resolveLocale({ stored: "", acceptLanguage: null })).toBe("en-IN");
  });

  it("reports which rung answered", () => {
    expect(resolveLocaleWithSource({ stored: "hi-IN" }).source).toBe("stored");
    expect(
      resolveLocaleWithSource({ acceptLanguage: "hi" }).source,
    ).toBe("header");
    expect(resolveLocaleWithSource({}).source).toBe("default");
  });
});

describe("matchAcceptLanguage", () => {
  it("matches a bare language to its regional catalog", () => {
    // A client that says "hi" is asking for Hindi. Refusing it over a missing
    // region would hand a Hindi speaker an English page.
    expect(matchAcceptLanguage("hi")).toBe("hi-IN");
    expect(matchAcceptLanguage("en")).toBe("en-IN");
  });

  it("matches a region we do not ship by its language", () => {
    expect(matchAcceptLanguage("en-US,en;q=0.9")).toBe("en-IN");
  });

  it("honours q-values rather than header order", () => {
    // The first entry is not always the preferred one — a user who reorders
    // their languages produces exactly this.
    expect(matchAcceptLanguage("en;q=0.4,hi;q=0.9")).toBe("hi-IN");
  });

  it("drops q=0, which means 'do not send me this'", () => {
    expect(matchAcceptLanguage("hi;q=0,en;q=0.5")).toBe("en-IN");
  });

  it("ignores the wildcard and anything unsupported", () => {
    expect(matchAcceptLanguage("*")).toBeNull();
    expect(matchAcceptLanguage("fr-FR,de;q=0.8")).toBeNull();
    expect(matchAcceptLanguage("")).toBeNull();
    expect(matchAcceptLanguage(null)).toBeNull();
  });

  it("survives a malformed header instead of throwing on it", () => {
    // Headers are attacker-controlled and also just frequently junk.
    expect(matchAcceptLanguage(",,;q=,hi;q=notanumber")).toBe("hi-IN");
  });
});

/* -------------------------------------------------------------- the catalogs */

describe("catalogs", () => {
  it("carry exactly the same keys", () => {
    // `tsc` already guarantees this — `hi` is declared `satisfies Catalog`.
    // Asserted anyway because the guarantee is worth one line, and a `as any`
    // added in a hurry would silence the compiler and not this.
    const english = Object.keys(CATALOGS["en-IN"]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort(), locale).toEqual(english);
    }
  });

  it("carry the same shape for every key", () => {
    for (const key of Object.keys(CATALOGS["en-IN"]) as MessageKey[]) {
      const english = CATALOGS["en-IN"][key];
      const hindi = CATALOGS["hi-IN"][key];
      expect(typeof hindi, key).toBe(typeof english);
    }
  });

  it("are actually translated, not copied", () => {
    // The failure this catches is a catalog stubbed out with the English text
    // to make the build pass, which then ships as a Hindi build that is not in
    // Hindi. Every value must contain Devanagari and must differ from the
    // English one. A string that is intentionally identical in both languages
    // — a wordmark, a bare numeral — belongs in this list with a reason.
    const INTENTIONALLY_IDENTICAL: MessageKey[] = [];

    for (const key of Object.keys(CATALOGS["en-IN"]) as MessageKey[]) {
      if (INTENTIONALLY_IDENTICAL.includes(key)) continue;

      const english = CATALOGS["en-IN"][key];
      const hindi = CATALOGS["hi-IN"][key];

      const englishText =
        typeof english === "string" ? english : english.other;
      const hindiText = typeof hindi === "string" ? hindi : hindi.other;

      expect(hindiText, key).not.toBe(englishText);
      expect(DEVANAGARI.test(hindiText), key).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------- plurals -- */

describe("pluralCategory", () => {
  it("puts zero in a different category in Hindi than in English", () => {
    // This is the whole argument for Intl.PluralRules over `count === 1`.
    // CLDR's Hindi rule is `i = 0 or n = 1`, so ZERO takes the singular form.
    // A hand-rolled check would be wrong for every empty list in the Hindi
    // build — and empty is the commonest count a list ever has.
    expect(pluralCategory("hi-IN", 0)).toBe("one");
    expect(pluralCategory("en-IN", 0)).toBe("other");
  });

  it("agrees with English at one and above one", () => {
    expect(pluralCategory("hi-IN", 1)).toBe("one");
    expect(pluralCategory("en-IN", 1)).toBe("one");
    expect(pluralCategory("hi-IN", 2)).toBe("other");
    expect(pluralCategory("en-IN", 2)).toBe("other");
  });
});

/* -------------------------------------------------------------------- t() -- */

describe("translate", () => {
  it("returns the plain string for the locale", () => {
    expect(translate("en-IN", "signin.phone.submit")).toBe("Send code");
    expect(translate("hi-IN", "signin.phone.submit")).toBe("कोड भेजें");
  });

  it("interpolates a value", () => {
    expect(translate("en-IN", "signin.dev.notice", { code: "482913" })).toContain(
      "your code is 482913.",
    );
    // Hindi puts the value before the verb. The same catalog key, the same
    // call, a different word order — which is only possible because the
    // sentence is one string with a hole in it rather than three JSX children.
    expect(translate("hi-IN", "signin.dev.notice", { code: "482913" })).toContain(
      "आपका कोड 482913 है",
    );
  });

  it("picks the English plural form by count", () => {
    expect(translate("en-IN", "signin.code.validFor", { count: 1 })).toBe(
      "This code works for 1 minute.",
    );
    expect(translate("en-IN", "signin.code.validFor", { count: 5 })).toBe(
      "This code works for 5 minutes.",
    );
  });

  it("picks a Hindi form through CLDR, including at zero", () => {
    // मिनट does not inflect, so both Hindi forms read the same. What is being
    // asserted is that the SELECTION went through Intl and produced a
    // grammatical sentence at a count where an `=== 1` check would have
    // reached for the plural form.
    expect(translate("hi-IN", "signin.code.validFor", { count: 0 })).toBe(
      "यह कोड 0 मिनट तक चलेगा।",
    );
    expect(translate("hi-IN", "signin.code.validFor", { count: 5 })).toBe(
      "यह कोड 5 मिनट तक चलेगा।",
    );
  });

  it("formats an interpolated number through Intl", () => {
    // Indian grouping, without the call site having to remember.
    expect(
      translate("en-IN", "signin.code.validFor", { count: 1234567 }),
    ).toContain("12,34,567");
  });

  it("binds a locale once", () => {
    const t = createTranslator("hi-IN");
    expect(t("signin.title")).toBe("साइन इन करें");
  });
});

/* ------------------------------------------------------------- the fallback */

describe("the missing-message fallback", () => {
  it("throws in development, naming the key and the locale", () => {
    // The cast IS the test. A missing key is unreachable through the typed
    // signature, so the only way here is somebody casting the compiler out of
    // their way at six in the evening — and that is precisely who needs to be
    // stopped. Loud, because the person who can fix it is at the keyboard and
    // a console warning is scrolled past.
    const unsafeTranslate = translate as unknown as (
      locale: Locale,
      key: string,
    ) => string;

    expect(() => unsafeTranslate("hi-IN", "signin.nope.not.a.key")).toThrow(
      /no message for "signin.nope.not.a.key" in hi-IN/,
    );
  });

  it("throws in development when a placeholder value is missing", () => {
    expect(() =>
      translate("en-IN", "signin.dev.notice", {} as { code: string }),
    ).toThrow(/no value for "\{code\}"/);
  });

  it("is silent, English and non-fatal in production", async () => {
    // The opposite trade. A student reading one English label in a Hindi form
    // has a slightly worse page; a student reading a crashed sign-in screen
    // has no page at all, and nothing on this path is worth an outage.
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const catalog = await import("@/i18n/catalog");
    const { translate: translateInProduction } = await import(
      "@/i18n/translate"
    );

    // A fresh module graph, so knocking a hole in it cannot affect any other
    // test. This is the gap the types are meant to make impossible.
    const hindi = catalog.CATALOGS["hi-IN"] as unknown as Record<
      string,
      unknown
    >;
    delete hindi["signin.title"];

    expect(translateInProduction("hi-IN", "signin.title")).toBe("Sign in");
    expect(logged).toHaveBeenCalledTimes(1);

    // And when even English has lost it, the key beats an empty element: it is
    // something a student can quote and somebody can grep for.
    const english = catalog.CATALOGS["en-IN"] as unknown as Record<
      string,
      unknown
    >;
    delete english["signin.title"];
    expect(translateInProduction("hi-IN", "signin.title")).toBe("signin.title");

    vi.resetModules();
  });
});

/* ------------------------------------------------------------- formatting -- */

describe("formatting", () => {
  it("groups numbers the Indian way in both locales", () => {
    // 12,34,567 — not 1,234,567. This is the whole reason the locale tags carry
    // a region: a bare `en` would print lakhs as millions on every screen.
    expect(formatNumber("en-IN", 1234567)).toBe("12,34,567");
    expect(formatNumber("hi-IN", 1234567)).toBe("12,34,567");
  });

  it("renders money from paise, in rupees", () => {
    // The column is `plans.price_paise`, an integer. Rupees only exist at the
    // edge where the number becomes text.
    const rendered = formatMoney("en-IN", 129900);
    expect(rendered).toContain("1,299");
    expect(rendered).toContain("₹");
  });

  it("renders a fraction as a percentage", () => {
    expect(formatPercent("en-IN", 0.62)).toBe("62%");
    expect(formatPercent("en-IN", 0.625, 1)).toBe("62.5%");
  });

  it("renders dates in IST, not in the server's zone", () => {
    // 19:00 UTC is 00:30 the NEXT day in Kolkata. A server on UTC would print
    // the 14th, and a teacher's browser would print the 15th, for the same
    // deadline. Pinning the zone is what stops the two disagreeing.
    const justAfterMidnightIst = new Date("2026-03-14T19:00:00Z");
    const rendered = formatDate("en-IN", justAfterMidnightIst);
    expect(rendered).toContain("15");
    expect(rendered).toContain("2026");
    expect(formatTime("en-IN", justAfterMidnightIst)).toContain("12:30");
  });

  it("renders Hindi dates in Devanagari on the Gregorian calendar", () => {
    const rendered = formatDate("hi-IN", new Date("2026-03-14T19:00:00Z"));
    expect(DEVANAGARI.test(rendered)).toBe(true);
    // India-only, so no Hindu-calendar month names to reconcile with a CBSE
    // timetable. Both locales resolve to Gregorian and we do not override it.
    expect(
      new Intl.DateTimeFormat("hi-IN").resolvedOptions().calendar,
    ).toBe("gregory");
  });
});

/* ------------------------------------------------------------------ tags -- */

describe("locale tags", () => {
  it("gives <html lang> the locale tag", () => {
    expect(htmlLang("hi-IN")).toBe("hi-IN");
    expect(htmlLang("en-IN")).toBe("en-IN");
  });

  it("guards the union at the edges", () => {
    expect(isLocale("hi-IN")).toBe(true);
    expect(isLocale("hi")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });

  it("names every locale in its own language, for a switcher to use", () => {
    // "Hindi", written in English, is unreadable to exactly the person who
    // needs to click it. A switcher offers हिन्दी.
    for (const locale of LOCALES) {
      const name: string = LOCALE_NAME[locale];
      expect(name.length, locale).toBeGreaterThan(0);
    }
    expect(DEVANAGARI.test(LOCALE_NAME["hi-IN"])).toBe(true);
  });
});
