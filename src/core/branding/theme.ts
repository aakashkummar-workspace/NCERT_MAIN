/**
 * A school's theme: validated, derived and turned into CSS.
 *
 * Pure, with no `server-only`, because it runs in three places — live in the
 * branding editor while a colour is being chosen, again on the server at save,
 * and a third time at render over whatever is stored. The same function each
 * time, so the verdict shown while typing is the verdict recorded.
 *
 * ---------------------------------------------------------------------------
 * A full theme, and the two guarantees it may not break
 * ---------------------------------------------------------------------------
 * Every contrast ratio in `globals.css` is measured, and the product promises
 * AA text contrast on every surface. Handing a school the palette would make
 * that promise theirs to break, and the person who pays is a student squinting
 * at pale grey on cream on a cheap phone in sunlight. So:
 *
 *   1. Every text colour is measured against every surface it can land on, in
 *      both modes, and a theme with a failing pair is REFUSED, never clamped.
 *      Clamping would save a colour the school did not choose and show them a
 *      preview that is not what they picked.
 *   2. The mastery scale is not themeable at all. Its colours mean "secure",
 *      "fragile" and "critical", and a school whose brand red became the
 *      critical colour would teach every teacher to read a warning as a logo.
 *
 * ---------------------------------------------------------------------------
 * The bar is AA — or Sahayak's own ratio, whichever is lower
 * ---------------------------------------------------------------------------
 * A handful of default pairs sit just under 4.5:1 on surfaces the token is not
 * actually drawn on (dark tertiary text on the raised surface, for one). A
 * validator holding a school to a stricter bar than the default palette meets
 * would refuse the default palette, and the first school to press Save without
 * changing anything would be told their theme is inaccessible. So each pair's
 * requirement is `min(AA, the default's ratio)`: a theme can never be WORSE
 * than what ships, and never worse than AA where what ships meets it.
 *
 * ---------------------------------------------------------------------------
 * One colour in, the whole primary scale out
 * ---------------------------------------------------------------------------
 * About thirty-five rules reference `--primary-50` … `--primary-900` directly,
 * so overriding `--accent` alone leaves every one of them indigo. Asking an
 * office to pick eight shades is asking for eight chances to fail contrast, so
 * the brand colour IS `--primary-600` and the rest are mixed from it with the
 * same white and black fractions the default indigo scale sits at. Feeding the
 * default indigo in reproduces the default scale to within a few units.
 */

export type Mode = "light" | "dark";

export const SURFACE_TOKENS = [
  "canvas",
  "surface",
  "surfaceRaised",
  "surfaceSunken",
] as const;

export const TEXT_TOKENS = ["textPrimary", "textSecondary", "textTertiary"] as const;

export const BORDER_TOKENS = ["border", "borderStrong"] as const;

export const PALETTE_TOKENS = [...SURFACE_TOKENS, ...BORDER_TOKENS, ...TEXT_TOKENS] as const;

export type PaletteToken = (typeof PALETTE_TOKENS)[number];

export type Palette = Partial<Record<PaletteToken, string>>;

export const FONTS = {
  inter: { label: "Inter", variable: "--font-inter" },
  "noto-sans": { label: "Noto Sans", variable: "--font-noto-sans" },
  "nunito-sans": { label: "Nunito Sans", variable: "--font-nunito-sans" },
} as const;

export type FontKey = keyof typeof FONTS;

/** What a school chooses. Every field is optional; absent means the default. */
export type ThemeInput = {
  brand?: string | null;
  light?: Palette;
  dark?: Palette;
  font?: FontKey | null;
};

/** What survived validation. Only lower-case six-digit hex, only known keys. */
export type Theme = {
  brand: string | null;
  light: Palette;
  dark: Palette;
  font: FontKey | null;
};

export const EMPTY_THEME: Theme = { brand: null, light: {}, dark: {}, font: null };

export const LABELS: Record<PaletteToken, string> = {
  canvas: "Page background",
  surface: "Card background",
  surfaceRaised: "Raised background",
  surfaceSunken: "Sunken background",
  border: "Border",
  borderStrong: "Strong border",
  textPrimary: "Main text",
  textSecondary: "Secondary text",
  textTertiary: "Faint text",
};

// ---------------------------------------------------------------------------
// The defaults, as effective hex — copied from globals.css
// ---------------------------------------------------------------------------

type Resolved = Record<PaletteToken, string> & {
  primary50: string;
  primary100: string;
  primary200: string;
  primary300: string;
  primary500: string;
  primary600: string;
  primary700: string;
  primary900: string;
  accent: string;
  accentHover: string;
  accentWash: string;
  focusRing: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
};

const DEFAULT_PRIMARY = {
  primary50: "#f1f2fd",
  primary100: "#e3e6fb",
  primary200: "#c8cdf6",
  primary300: "#a6aeef",
  primary500: "#5f6bda",
  primary600: "#4a56d2",
  primary700: "#3b45ae",
  primary900: "#2a3170",
};

export const DEFAULTS: Record<Mode, Resolved> = {
  light: {
    ...DEFAULT_PRIMARY,
    canvas: "#f5f7fa",
    surface: "#ffffff",
    surfaceRaised: "#fafbfc",
    surfaceSunken: "#edf0f5",
    border: "#dfe3eb",
    borderStrong: "#c7cdd9",
    textPrimary: "#151922",
    textSecondary: "#545c6b",
    textTertiary: "#5f6877",
    accent: "#4a56d2",
    accentHover: "#3b45ae",
    accentWash: "#f1f2fd",
    focusRing: "#4a56d2",
    success: "#0f7a4d",
    warning: "#9c5d00",
    danger: "#c2352b",
    info: "#0b69b8",
  },
  dark: {
    ...DEFAULT_PRIMARY,
    canvas: "#0b0d12",
    surface: "#151922",
    surfaceRaised: "#1c2130",
    surfaceSunken: "#10141d",
    border: "#2a3040",
    borderStrong: "#3a4256",
    textPrimary: "#edf0f5",
    textSecondary: "#a3adbf",
    textTertiary: "#78829a",
    accent: "#a6aeef",
    accentHover: "#c8cdf6",
    accentWash: "#1a1e30",
    focusRing: "#a6aeef",
    success: "#4abe86",
    warning: "#e0a81a",
    danger: "#f0796e",
    info: "#5faeea",
  },
};

/** The mastery colours a brand colour must not be mistaken for. */
const MASTERY_MEANINGS: { hex: string; meaning: string }[] = [
  { hex: "#0f7a4d", meaning: "secure" },
  { hex: "#9c5d00", meaning: "fragile" },
  { hex: "#c2352b", meaning: "critical" },
];

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/;

/**
 * "#ABC", "abcdef" and "#AbCdEf" in; "#aabbcc" out, or null.
 *
 * This is the only gate between a value a person typed and a `<style>` element,
 * so it admits exactly seven characters from a sixteen-letter alphabet and
 * nothing else — no `rgb()`, no names, no `var()`, and therefore nothing that
 * could close a declaration or open a new one.
 */
export function normaliseHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase();
  if (!text.startsWith("#")) text = `#${text}`;
  if (/^#[0-9a-f]{3}$/.test(text)) {
    text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  return HEX.test(text) ? text : null;
}

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b]
    .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** WCAG 2 relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** `amount` of `toward` mixed into `hex`, in sRGB. */
function mix(hex: string, toward: string, amount: number): string {
  const a = channels(hex);
  const b = channels(toward);
  return toHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

/**
 * The eight primary steps from one colour.
 *
 * The fractions were read off the default indigo scale, so the derived scale
 * has the same shape as the one every component was designed against.
 */
export function primaryScale(brand: string) {
  return {
    primary50: mix(brand, "#ffffff", 0.93),
    primary100: mix(brand, "#ffffff", 0.85),
    primary200: mix(brand, "#ffffff", 0.7),
    primary300: mix(brand, "#ffffff", 0.51),
    primary500: mix(brand, "#ffffff", 0.12),
    primary600: brand,
    primary700: mix(brand, "#000000", 0.2),
    primary900: mix(brand, "#000000", 0.44),
  };
}

function resolve(theme: Theme, mode: Mode): Resolved {
  const base = DEFAULTS[mode];
  const scale = theme.brand ? primaryScale(theme.brand) : DEFAULT_PRIMARY;
  const palette = mode === "light" ? theme.light : theme.dark;

  const resolved: Resolved = { ...base, ...scale, ...palette } as Resolved;

  if (theme.brand) {
    if (mode === "light") {
      resolved.accent = scale.primary600;
      resolved.accentHover = scale.primary700;
      resolved.accentWash = scale.primary50;
      resolved.focusRing = scale.primary600;
    } else {
      resolved.accent = scale.primary300;
      resolved.accentHover = scale.primary200;
      // A wash is a tint of the brand over the dark card, not a light step.
      resolved.accentWash = mix(resolved.surface, theme.brand, 0.14);
      resolved.focusRing = scale.primary300;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The pairs that must stay readable
// ---------------------------------------------------------------------------

type PairKey = keyof Resolved | "white";

type Pair = { fg: PairKey; bg: PairKey; min: number; what: string };

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

const FG_NAMES: Record<string, string> = {
  textPrimary: "Main text",
  textSecondary: "Secondary text",
  textTertiary: "Faint text",
  accent: "Links and highlights",
  primary700: "Dark brand text",
  success: "'Success' text",
  warning: "'Warning' text",
  danger: "'Danger' text",
  info: "'Info' text",
  white: "White button text",
  focusRing: "The keyboard focus ring",
};

const BG_NAMES: Record<string, string> = {
  canvas: "the page background",
  surface: "the card background",
  surfaceRaised: "the raised background",
  surfaceSunken: "the sunken background",
  primary600: "the brand colour",
  primary700: "the darker brand colour",
  accentWash: "the highlighted-row background",
};

function pairsFor(mode: Mode): Pair[] {
  const pairs: Pair[] = [];
  const foregrounds: PairKey[] = [
    ...TEXT_TOKENS,
    "accent",
    ...(mode === "light" ? (["primary700"] as const) : []),
    "success",
    "warning",
    "danger",
    "info",
  ];
  for (const fg of foregrounds) {
    for (const bg of SURFACE_TOKENS) {
      pairs.push({ fg, bg, min: AA_TEXT, what: "text" });
    }
  }
  // The primary button is white on a brand gradient in BOTH modes.
  pairs.push({ fg: "white", bg: "primary600", min: AA_TEXT, what: "text" });
  pairs.push({ fg: "white", bg: "primary700", min: AA_TEXT, what: "text" });
  // The current item in a navigation list.
  pairs.push({ fg: "accent", bg: "accentWash", min: AA_TEXT, what: "text" });
  // A focus ring is a non-text indicator, and it must be findable.
  pairs.push({ fg: "focusRing", bg: "canvas", min: AA_NON_TEXT, what: "indicator" });
  pairs.push({ fg: "focusRing", bg: "surface", min: AA_NON_TEXT, what: "indicator" });
  return pairs;
}

function colourOf(resolved: Resolved, key: PairKey): string {
  return key === "white" ? "#ffffff" : resolved[key];
}

export type Check = {
  mode: Mode;
  foreground: string;
  background: string;
  ratio: number;
  required: number;
  passes: boolean;
  /** A sentence, because this is what a school office reads. */
  message: string;
};

function checksFor(theme: Theme): Check[] {
  const checks: Check[] = [];
  for (const mode of ["light", "dark"] as const) {
    const resolved = resolve(theme, mode);
    const defaults = resolve(EMPTY_THEME, mode);
    for (const pair of pairsFor(mode)) {
      const ratio = contrast(colourOf(resolved, pair.fg), colourOf(resolved, pair.bg));
      const shipped = contrast(colourOf(defaults, pair.fg), colourOf(defaults, pair.bg));
      // Never worse than what ships, and never worse than AA where it meets AA.
      const required = Math.min(pair.min, Math.floor(shipped * 100) / 100);
      const passes = ratio + 1e-9 >= required;
      const fgName = FG_NAMES[pair.fg] ?? pair.fg;
      const bgName = BG_NAMES[pair.bg] ?? pair.bg;
      checks.push({
        mode,
        foreground: fgName,
        background: bgName,
        ratio: Math.round(ratio * 100) / 100,
        required,
        passes,
        message: `${fgName} on ${bgName} (${mode} mode) is ${ratio.toFixed(2)}:1 and needs at least ${required.toFixed(2)}:1.`,
      });
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Finding = { field: string; message: string };

export type ThemeVerdict =
  | { ok: true; theme: Theme; warnings: Finding[]; checks: Check[] }
  | { ok: false; errors: Finding[]; warnings: Finding[]; checks: Check[] };

export function validateTheme(input: unknown): ThemeVerdict {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  const theme: Theme = { brand: null, light: {}, dark: {}, font: null };

  if (raw.brand !== undefined && raw.brand !== null && raw.brand !== "") {
    const brand = normaliseHex(raw.brand);
    if (!brand) {
      errors.push({ field: "brand", message: "The brand colour must be a hex colour such as #1f4e9c." });
    } else {
      theme.brand = brand;
    }
  }

  for (const mode of ["light", "dark"] as const) {
    const palette = raw[mode];
    if (palette === undefined || palette === null) continue;
    if (typeof palette !== "object") {
      errors.push({ field: mode, message: `The ${mode} palette could not be read.` });
      continue;
    }
    for (const [key, value] of Object.entries(palette as Record<string, unknown>)) {
      if (!(PALETTE_TOKENS as readonly string[]).includes(key)) {
        // Refused rather than dropped. A key that silently does nothing is a
        // colour somebody believes they set.
        errors.push({ field: `${mode}.${key}`, message: `"${key}" is not a colour a theme can set.` });
        continue;
      }
      if (value === undefined || value === null || value === "") continue;
      const hex = normaliseHex(value);
      if (!hex) {
        errors.push({
          field: `${mode}.${key}`,
          message: `${LABELS[key as PaletteToken]} (${mode} mode) must be a hex colour such as #f5f7fa.`,
        });
        continue;
      }
      theme[mode][key as PaletteToken] = hex;
    }
  }

  if (raw.font !== undefined && raw.font !== null && raw.font !== "") {
    if (typeof raw.font === "string" && raw.font in FONTS) {
      theme.font = raw.font as FontKey;
    } else {
      errors.push({ field: "font", message: "Choose one of the fonts offered." });
    }
  }

  // Malformed values first: measuring contrast on a colour that did not parse
  // would produce a second error about a colour nobody chose.
  if (errors.length > 0) return { ok: false, errors, warnings, checks: [] };

  if (theme.brand) {
    for (const reserved of MASTERY_MEANINGS) {
      if (distance(theme.brand, reserved.hex) < 70) {
        warnings.push({
          field: "brand",
          message: `Your brand colour is close to the colour that means "${reserved.meaning}" on progress displays. Buttons and highlights will be in it, so a teacher may read one as a verdict on a student. The progress colours stay as they are either way.`,
        });
      }
    }
  }

  const checks = checksFor(theme);
  for (const check of checks) {
    if (!check.passes) errors.push({ field: `contrast.${check.mode}`, message: check.message });
  }

  return errors.length > 0
    ? { ok: false, errors, warnings, checks }
    : { ok: true, theme, warnings, checks };
}

/**
 * The nearest darker shade of a brand colour that passes, or null.
 *
 * Gold, saffron and sky blue are common school colours and every one of them
 * fails white button text. "Refused" with forty contrast lines teaches an
 * office nothing; "#8a6d00 is your gold, dark enough to read" is a decision
 * they can take. It is only ever OFFERED — the editor never swaps the colour
 * in on its own, for the same reason the validator never clamps.
 */
export function suggestBrand(input: ThemeInput): string | null {
  const brand = normaliseHex(input.brand);
  if (!brand) return null;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(brand, "#000000", step * 0.05);
    if (validateTheme({ ...input, brand: candidate }).ok) return candidate;
  }
  return null;
}

function distance(a: string, b: string): number {
  const x = channels(a);
  const y = channels(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * The theme a stored value may render as, or null.
 *
 * Runs the whole validator again rather than trusting the row. The row is
 * written by the save path, which validated it — and also by a migration, a
 * support fix over psql, and whatever the next feature is. A theme that fails
 * contrast renders as the default, not as the stored colours.
 */
export function storedTheme(value: unknown): Theme | null {
  const verdict = validateTheme(value);
  if (!verdict.ok) return null;
  const theme = verdict.theme;
  const empty =
    !theme.brand &&
    !theme.font &&
    Object.keys(theme.light).length === 0 &&
    Object.keys(theme.dark).length === 0;
  return empty ? null : theme;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS_NAMES: Record<string, string> = {
  primary50: "--primary-50",
  primary100: "--primary-100",
  primary200: "--primary-200",
  primary300: "--primary-300",
  primary500: "--primary-500",
  primary600: "--primary-600",
  primary700: "--primary-700",
  primary900: "--primary-900",
  canvas: "--canvas",
  surface: "--surface",
  surfaceRaised: "--surface-raised",
  surfaceSunken: "--surface-sunken",
  border: "--border",
  borderStrong: "--border-strong",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textTertiary: "--text-tertiary",
  accent: "--accent",
  accentHover: "--accent-hover",
  accentWash: "--accent-wash",
  focusRing: "--focus-ring",
};

function declarations(theme: Theme, mode: Mode): string {
  const resolved = resolve(theme, mode);
  const names = new Set<string>(Object.keys(mode === "light" ? theme.light : theme.dark));
  if (theme.brand) {
    if (mode === "light") {
      for (const key of Object.keys(DEFAULT_PRIMARY)) names.add(key);
    }
    for (const key of ["accent", "accentHover", "accentWash", "focusRing"]) names.add(key);
  }
  return [...names]
    .sort()
    .map((key) => {
      const value = resolved[key as keyof Resolved];
      // Belt and braces: `resolve` only ever holds validated hex, and this is
      // the line that writes into a <style> element.
      if (!HEX.test(value)) throw new Error(`Refusing to emit a non-hex value for ${key}`);
      return `${CSS_NAMES[key]}:${value};`;
    })
    .join("");
}

/**
 * The stylesheet a theme renders as.
 *
 * Emitted with the SAME three selectors `globals.css` uses — bare `:root`, the
 * system-dark media query guarded by `:not([data-theme="light"])`, and the
 * explicit `[data-theme="dark"]` — so a school's dark palette wins in exactly
 * the cases the default dark palette would have, and the theme toggle keeps
 * working in both directions. Equal specificity, later in the document.
 */
export function themeCss(theme: Theme): string {
  const light = declarations(theme, "light");
  const dark = declarations(theme, "dark");
  const font = theme.font
    ? `body{font-family:var(${FONTS[theme.font].variable}),system-ui,-apple-system,"Segoe UI",sans-serif;}`
    : "";
  return [
    light ? `:root{${light}}` : "",
    dark
      ? `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}`
      : "",
    font,
  ].join("");
}

/** The effective colours, for a preview that must show what will render. */
export function previewColours(theme: Theme, mode: Mode) {
  const resolved = resolve(theme, mode);
  return {
    canvas: resolved.canvas,
    surface: resolved.surface,
    surfaceSunken: resolved.surfaceSunken,
    border: resolved.border,
    textPrimary: resolved.textPrimary,
    textSecondary: resolved.textSecondary,
    textTertiary: resolved.textTertiary,
    accent: resolved.accent,
    accentWash: resolved.accentWash,
    primary600: resolved.primary600,
    primary700: resolved.primary700,
  };
}
