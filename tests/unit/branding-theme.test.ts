import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  contrast,
  normaliseHex,
  primaryScale,
  storedTheme,
  suggestBrand,
  themeCss,
  validateTheme,
} from "@/core/branding/theme";
import { sniffLogo, MAX_LOGO_BYTES } from "@/core/branding/logo";
import { BrandingDetails } from "@/core/branding/details";

/**
 * A school's theme, in the parts decidable without a database.
 *
 * The claims that matter: the default palette passes its own check (or the
 * first school to press Save is told Sahayak is unreadable), a failing theme is
 * refused rather than clamped, and nothing but hex ever reaches a <style>.
 */

describe("the default palette", () => {
  it("passes its own validator", () => {
    const verdict = validateTheme({});
    expect(verdict.ok).toBe(true);
  });

  it("reproduces itself from the default indigo", () => {
    // Derived, not copied: within a few units per channel of the shipped scale.
    const scale = primaryScale("#4a56d2");
    const shipped = DEFAULTS.light;
    for (const key of ["primary50", "primary300", "primary700", "primary900"] as const) {
      expect(contrast(scale[key], shipped[key])).toBeLessThan(1.06);
    }
  });

  it("matches the ratios documented in globals.css", () => {
    expect(contrast("#4a56d2", "#ffffff")).toBeCloseTo(5.91, 1);
    expect(contrast("#151922", "#ffffff")).toBeCloseTo(17.59, 1);
  });
});

describe("a theme that would be hard to read is refused", () => {
  it("refuses a brand colour too light for white button text", () => {
    const verdict = validateTheme({ brand: "#f5c400" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors.some((e) => /White button text/.test(e.message))).toBe(true);
  });

  it("refuses pale text on a pale page", () => {
    const verdict = validateTheme({ light: { textSecondary: "#b0b0b0" } });
    expect(verdict.ok).toBe(false);
  });

  it("refuses a dark page in light mode, because the status colours are not themeable", () => {
    const verdict = validateTheme({
      light: { canvas: "#101010", surface: "#101010", surfaceRaised: "#101010", surfaceSunken: "#101010" },
    });
    expect(verdict.ok).toBe(false);
  });

  it("offers a darker shade that passes, and never swaps it in", () => {
    const suggestion = suggestBrand({ brand: "#f5c400" });
    expect(suggestion).toMatch(/^#[0-9a-f]{6}$/);
    expect(validateTheme({ brand: suggestion }).ok).toBe(true);
    // The input is untouched: refusing is the validator's job, choosing is the school's.
    expect(validateTheme({ brand: "#f5c400" }).ok).toBe(false);
  });

  it("accepts a readable school palette", () => {
    const verdict = validateTheme({ brand: "#1f4e9c", light: { canvas: "#fff8e7" }, font: "noto-sans" });
    expect(verdict.ok).toBe(true);
  });

  it("warns, never blocks, when a brand colour looks like a mastery verdict", () => {
    const verdict = validateTheme({ brand: "#b3261e" });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.some((w) => /critical/.test(w.message))).toBe(true);
  });
});

describe("only hex reaches a stylesheet", () => {
  it("normalises short and upper-case hex and rejects everything else", () => {
    expect(normaliseHex("#ABC")).toBe("#aabbcc");
    expect(normaliseHex("1F4E9C")).toBe("#1f4e9c");
    for (const bad of ["red", "rgb(0,0,0)", "#12345", "#1f4e9c;}body{display:none", "var(--x)", 7]) {
      expect(normaliseHex(bad)).toBeNull();
    }
  });

  it("refuses an injection attempt rather than dropping it", () => {
    const verdict = validateTheme({ brand: "#000;}</style><script>alert(1)</script>" });
    expect(verdict.ok).toBe(false);
  });

  it("refuses a key that is not a themeable token", () => {
    const verdict = validateTheme({ light: { masteryCritical: "#000000" } });
    expect(verdict.ok).toBe(false);
  });

  it("emits the same three selectors globals.css uses and nothing but hex values", () => {
    const verdict = validateTheme({ brand: "#1f4e9c", dark: { canvas: "#000000" } });
    if (!verdict.ok) throw new Error("expected a valid theme");
    const css = themeCss(verdict.theme);
    expect(css).toContain(":root{");
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--primary-600:#1f4e9c;");
    expect(css).not.toMatch(/mastery/);
    for (const [, value] of css.matchAll(/--[a-z0-9-]+:([^;]+);/g)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("renders a stored theme that no longer validates as the default", () => {
    expect(storedTheme({ brand: "#f5c400" })).toBeNull();
    expect(storedTheme({})).toBeNull();
    expect(storedTheme({ brand: "#1f4e9c" })).not.toBeNull();
  });
});

describe("a logo is judged by its bytes", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it("accepts PNG, JPEG and WebP signatures", () => {
    expect(sniffLogo(png)).toEqual({ ok: true, mime: "image/png" });
    expect(sniffLogo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ok: true, mime: "image/jpeg" });
    const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
    expect(sniffLogo(webp)).toEqual({ ok: true, mime: "image/webp" });
  });

  it("refuses SVG, with a reason an office can act on", () => {
    const verdict = sniffLogo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toMatch(/PNG/);
  });

  it("refuses an HTML file renamed to .png", () => {
    expect(sniffLogo(new TextEncoder().encode("<html><script>x</script></html>")).ok).toBe(false);
  });

  it("refuses an oversized file", () => {
    const big = new Uint8Array(MAX_LOGO_BYTES + 1);
    big.set(png);
    expect(sniffLogo(big).ok).toBe(false);
  });
});

describe("school details", () => {
  it("turns empty strings into nothing", () => {
    const parsed = BrandingDetails.parse({ displayName: "  ", address: "" });
    expect(parsed.displayName).toBeNull();
    expect(parsed.address).toBeNull();
  });

  it("refuses a website that is not https — it becomes an href on a public page", () => {
    expect(BrandingDetails.safeParse({ website: "javascript:alert(1)" }).success).toBe(false);
    expect(BrandingDetails.safeParse({ website: "http://school.example" }).success).toBe(false);
    expect(BrandingDetails.safeParse({ website: "https://school.example" }).success).toBe(true);
  });

  it("caps signature lines at what a sheet has room for", () => {
    expect(BrandingDetails.safeParse({ signatories: ["a", "b", "c", "d"] }).success).toBe(false);
  });
});

describe("the letters in the mark", () => {
  it("skips the words nobody puts in a monogram, and keeps a possessive whole", async () => {
    const { initials } = await import("@/core/branding/details");
    expect(initials("St. Mary's Convent School")).toBe("MC");
    expect(initials("St. Test's School")).toBe("T");
    expect(initials("Delhi Public School")).toBe("DP");
    expect(initials("School")).toBe("S");
  });
});
