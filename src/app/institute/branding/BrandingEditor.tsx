"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { EditorState } from "@/core/branding";
import { BrandingDetails, MAX_SIGNATORIES, initials as initialsOf } from "@/core/branding/details";
import { MAX_LOGO_BYTES } from "@/core/branding/logo";
import {
  DEFAULTS,
  FONTS,
  LABELS,
  PALETTE_TOKENS,
  normaliseHex,
  previewColours,
  suggestBrand,
  validateTheme,
  type FontKey,
  type Mode,
  type PaletteToken,
  type Theme,
} from "@/core/branding/theme";

/**
 * The branding editor.
 *
 * ---------------------------------------------------------------------------
 * The verdict is live, and it is the server's verdict
 * ---------------------------------------------------------------------------
 * `validateTheme` and `BrandingDetails` are the same pure functions the save
 * route runs, so a colour that fails contrast is flagged while it is being
 * picked, with the sentence the server would send. Nobody presses Save and
 * meets a refusal they could have been shown.
 *
 * ---------------------------------------------------------------------------
 * The preview shows what will render, not what was typed
 * ---------------------------------------------------------------------------
 * It is drawn from `previewColours`, the resolver the stylesheet is built
 * from — derived shades included — in both modes side by side. An office that
 * picks a colour on a light screen should see what a student with dark mode on
 * will get before a student does.
 */

type Details = EditorState["details"];

const MODES: Mode[] = ["light", "dark"];

export function BrandingEditor({ initial }: { initial: EditorState }) {
  const router = useRouter();
  const [details, setDetails] = useState<Details>(initial.details);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [logoUrl, setLogoUrl] = useState<string | null>(initial.logoUrl);
  const [pending, setPending] = useState(false);
  const [logoPending, setLogoPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const verdict = useMemo(() => validateTheme(theme), [theme]);
  const detailsCheck = useMemo(() => BrandingDetails.safeParse(details), [details]);
  const fieldErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!detailsCheck.success) {
      for (const issue of detailsCheck.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !errors[key]) errors[key] = issue.message;
      }
    }
    return errors;
  }, [detailsCheck]);

  const contrastFailures = verdict.ok ? [] : verdict.errors;
  const suggestion = useMemo(
    () => (!verdict.ok && theme.brand ? suggestBrand(theme) : null),
    [verdict, theme],
  );

  const canSave = verdict.ok && detailsCheck.success && !pending;
  const displayName = details.displayName.trim() || initial.organizationName;

  function setDetail<K extends keyof Details>(key: K, value: Details[K]) {
    setDetails((current) => ({ ...current, [key]: value }));
    setMessage(null);
  }

  function setBrand(value: string | null) {
    setTheme((current) => ({ ...current, brand: value }));
    setMessage(null);
  }

  function setPalette(mode: Mode, token: PaletteToken, value: string | null) {
    setTheme((current) => {
      const palette = { ...current[mode] };
      if (value) palette[token] = value;
      else delete palette[token];
      return { ...current, [mode]: palette };
    });
    setMessage(null);
  }

  async function save() {
    setPending(true);
    setMessage(null);
    try {
      // Trailing slash: `trailingSlash: true` 308s a PUT to the bare path and
      // the body is lost on the redirect.
      const response = await fetch("/api/institute/branding/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ details, theme }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage({ tone: "error", text: json?.error?.message ?? "That did not save. Try again." });
        return;
      }
      setMessage({
        tone: "ok",
        text: "Saved. Every screen in your school now uses it — reports already written keep the letterhead they were written with.",
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function upload(file: File) {
    setLogoError(null);
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`A logo can be at most ${MAX_LOGO_BYTES / 1024} KB.`);
      return;
    }
    setLogoPending(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/institute/branding/logo/", { method: "POST", body: form });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setLogoError(json?.error?.message ?? "That logo did not upload. Try again.");
        return;
      }
      setLogoUrl(json.url);
      router.refresh();
    } finally {
      setLogoPending(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeLogo() {
    setLogoPending(true);
    setLogoError(null);
    try {
      const response = await fetch("/api/institute/branding/logo/", { method: "DELETE" });
      if (!response.ok) {
        setLogoError("That did not work. Try again.");
        return;
      }
      setLogoUrl(null);
      router.refresh();
    } finally {
      setLogoPending(false);
    }
  }

  const text = (key: keyof Details, label: string, hint?: string, placeholder?: string) => (
    <label className="ui-field">
      <span>{label}</span>
      <input
        className="ui-input"
        value={details[key] as string}
        placeholder={placeholder}
        aria-invalid={fieldErrors[key] ? true : undefined}
        onChange={(event) => setDetail(key, event.target.value as never)}
      />
      {hint && <span className="ui-bx-hint">{hint}</span>}
      {fieldErrors[key] && <span className="ui-bx-error">{fieldErrors[key]}</span>}
    </label>
  );

  return (
    <div className="ui-bx">
      <div>
        {!initial.storedThemeRenders && (
          <p className="ui-bx-error" role="alert">
            The colours saved for your school no longer pass the readability
            check, so every screen is showing the default colours instead. Choose
            colours below and save to put yours back.
          </p>
        )}

        <fieldset className="ui-bx-section">
          <legend>Name and logo</legend>
          <div className="ui-bx-fields">
            {text(
              "displayName",
              "School name",
              `Shown on every screen. Leave empty to use "${initial.organizationName}".`,
            )}
            {text(
              "shortName",
              "Initials",
              "Up to 4 letters, shown in the square when there is no logo.",
            )}
          </div>
          {text("tagline", "Motto or tagline", "Optional. Shown under the name.")}

          <div className="ui-bx-logo">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="ui-bx-logo-preview" src={logoUrl} alt="Your current logo" />
            ) : (
              <span className="ui-bx-hint">No logo yet.</span>
            )}
            <label className="ui-button" data-variant="secondary" data-size="md">
              <span>{logoPending ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}</span>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                disabled={logoPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </label>
            {logoUrl && (
              <button
                type="button"
                className="ui-button"
                data-variant="ghost"
                data-size="md"
                disabled={logoPending}
                onClick={removeLogo}
              >
                <span>Remove logo</span>
              </button>
            )}
          </div>
          <span className="ui-bx-hint">
            PNG, JPEG or WebP, up to {MAX_LOGO_BYTES / 1024} KB. A square logo on a
            transparent background looks best. A logo is saved as soon as it is
            uploaded.
          </span>
          {logoError && (
            <span className="ui-bx-error" role="alert">
              {logoError}
            </span>
          )}
        </fieldset>

        <fieldset className="ui-bx-section">
          <legend>Colours and font</legend>
          <p>
            Your brand colour is used for buttons, links and highlights, and the
            lighter and darker shades are worked out from it. Every text colour is
            checked against every background it can appear on, in light and dark
            mode, so everything stays readable on a cheap phone in sunlight.
            Progress colours — secure, fragile, critical — never change.
          </p>

          <ColourField
            label="Brand colour"
            value={theme.brand}
            defaultHint="Sahayak indigo"
            defaultSwatch={DEFAULTS.light.primary600}
            onChange={setBrand}
          />

          {suggestion && (
            <p className="ui-bx-hint" role="status">
              That colour is too light for white button text. The nearest shade that
              works is <code>{suggestion}</code>.{" "}
              <button
                type="button"
                className="ui-link-button"
                onClick={() => setBrand(suggestion)}
              >
                Use {suggestion}
              </button>
            </p>
          )}

          <label className="ui-field">
            <span>Font</span>
            <select
              className="ui-input"
              value={theme.font ?? ""}
              onChange={(event) =>
                setTheme((current) => ({
                  ...current,
                  font: (event.target.value || null) as FontKey | null,
                }))
              }
            >
              <option value="">Inter (default)</option>
              {(Object.keys(FONTS) as FontKey[])
                .filter((key) => key !== "inter")
                .map((key) => (
                  <option key={key} value={key}>
                    {FONTS[key].label}
                  </option>
                ))}
            </select>
            <span className="ui-bx-hint">
              Noto Sans also covers Hindi, if your students use the Hindi interface.
            </span>
          </label>

          {MODES.map((mode) => (
            <details key={mode}>
              <summary>
                {mode === "light" ? "Light mode" : "Dark mode"} backgrounds and text
                {Object.keys(theme[mode]).length > 0 &&
                  ` (${Object.keys(theme[mode]).length} changed)`}
              </summary>
              <div className="ui-bx-colours" style={{ marginTop: 12 }}>
                {PALETTE_TOKENS.map((token) => (
                  <ColourField
                    key={token}
                    label={LABELS[token]}
                    value={theme[mode][token] ?? null}
                    defaultHint="default"
                    defaultSwatch={DEFAULTS[mode][token]}
                    onChange={(value) => setPalette(mode, token, value)}
                  />
                ))}
              </div>
            </details>
          ))}

          {contrastFailures.length > 0 && (
            <div role="alert">
              <p className="ui-bx-error">
                {contrastFailures.length === 1
                  ? "One combination would be hard to read:"
                  : `${contrastFailures.length} combinations would be hard to read:`}
              </p>
              <ul className="ui-bx-verdicts">
                {contrastFailures.slice(0, 6).map((finding) => (
                  <li key={finding.field + finding.message}>{finding.message}</li>
                ))}
              </ul>
              {contrastFailures.length > 6 && (
                // A truncated list says it is truncated.
                <p className="ui-bx-hint">
                  And {contrastFailures.length - 6} more, not listed here.
                </p>
              )}
            </div>
          )}
          {verdict.warnings.map((warning) => (
            <p key={warning.message} className="ui-bx-hint" role="note">
              {warning.message}
            </p>
          ))}
        </fieldset>

        <fieldset className="ui-bx-section">
          <legend>Official details</legend>
          <p>Printed at the top of term reports. Nothing here is shown on the public sign-in page.</p>
          {text("address", "Address")}
          <div className="ui-bx-fields">
            {text("affiliationNumber", "CBSE affiliation number")}
            {text("schoolCode", "School code")}
            {text("principalName", "Principal's name")}
            {text("contactPhone", "Office phone")}
            {text("contactEmail", "Office email")}
            {text("website", "Website", undefined, "https://")}
          </div>
        </fieldset>

        <fieldset className="ui-bx-section">
          <legend>Reports</legend>
          <label className="ui-field">
            <span>Footer note</span>
            <textarea
              className="ui-input"
              rows={3}
              value={details.reportFooter}
              aria-invalid={fieldErrors.reportFooter ? true : undefined}
              onChange={(event) => setDetail("reportFooter", event.target.value)}
            />
            <span className="ui-bx-hint">
              Printed above Sahayak&rsquo;s own note explaining that a report is not a
              ranking — that note always stays.
            </span>
            {fieldErrors.reportFooter && (
              <span className="ui-bx-error">{fieldErrors.reportFooter}</span>
            )}
          </label>

          <div className="ui-field">
            <span>Signature lines</span>
            {details.signatories.map((role, index) => (
              <div key={index} className="ui-bx-actions">
                <input
                  className="ui-input"
                  aria-label={`Signature line ${index + 1}`}
                  value={role}
                  onChange={(event) =>
                    setDetail(
                      "signatories",
                      details.signatories.map((item, i) => (i === index ? event.target.value : item)),
                    )
                  }
                />
                <button
                  type="button"
                  className="ui-button"
                  data-variant="ghost"
                  data-size="sm"
                  onClick={() =>
                    setDetail(
                      "signatories",
                      details.signatories.filter((_, i) => i !== index),
                    )
                  }
                >
                  <span>Remove</span>
                </button>
              </div>
            ))}
            {details.signatories.length < MAX_SIGNATORIES && (
              <button
                type="button"
                className="ui-button"
                data-variant="secondary"
                data-size="sm"
                style={{ justifySelf: "start", alignSelf: "flex-start" }}
                onClick={() =>
                  setDetail("signatories", [
                    ...details.signatories,
                    details.signatories.length === 0 ? "Class teacher" : "Principal",
                  ])
                }
              >
                <span>Add a signature line</span>
              </button>
            )}
            {fieldErrors.signatories && (
              <span className="ui-bx-error">{fieldErrors.signatories}</span>
            )}
          </div>

          <label className="ui-bx-check">
            <input
              type="checkbox"
              checked={details.hidePoweredBy}
              onChange={(event) => setDetail("hidePoweredBy", event.target.checked)}
            />
            <span>
              Hide &ldquo;Powered by Sahayak&rdquo;
              <span className="ui-bx-hint" style={{ display: "block" }}>
                Removes the attribution from screens, the sign-in page and printed
                reports.
              </span>
            </span>
          </label>
        </fieldset>

        <div className="ui-bx-actions">
          <button
            type="button"
            className="ui-button"
            data-variant="primary"
            disabled={!canSave}
            onClick={save}
          >
            <span>{pending ? "Saving…" : "Save branding"}</span>
          </button>
          {!verdict.ok && (
            <span className="ui-bx-hint">Fix the colours above before saving.</span>
          )}
          {message && (
            <span
              className={message.tone === "ok" ? "ui-bx-hint" : "ui-bx-error"}
              role={message.tone === "ok" ? "status" : "alert"}
            >
              {message.text}
            </span>
          )}
        </div>
      </div>

      <aside className="ui-bx-aside" aria-label="Preview">
        {MODES.map((mode) => (
          <Preview
            key={mode}
            mode={mode}
            theme={verdict.ok ? verdict.theme : theme}
            name={displayName}
            initials={details.shortName.trim() || initialsOf(displayName)}
            logoUrl={logoUrl}
          />
        ))}
        <p className="ui-bx-hint">
          Your school&rsquo;s sign-in page:{" "}
          <a href={`/school/${initial.slug}/`}>/school/{initial.slug}</a>
          <br />
          Share it with teachers, students and parents. It shows your name, logo
          and colours — and nothing from the official details.
        </p>
      </aside>
    </div>
  );
}

function ColourField({
  label,
  value,
  defaultHint,
  defaultSwatch = "#ffffff",
  onChange,
}: {
  label: string;
  value: string | null;
  defaultHint: string;
  defaultSwatch?: string;
  onChange: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [lastValue, setLastValue] = useState(value);
  // Keep the text box in step when the value changes from outside (a
  // suggestion accepted), without an effect.
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value ?? "");
  }
  const invalid = draft.trim() !== "" && normaliseHex(draft) === null;

  return (
    <div className="ui-bx-colour">
      <input
        type="color"
        aria-label={`${label} picker`}
        // Unset shows the colour that will actually render, not a white swatch
        // that reads as "your brand colour is white".
        value={value ?? defaultSwatch}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="ui-bx-colour-label">
        <span>{label}</span>
        <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="ui-input"
            aria-label={`${label} hex value`}
            value={draft}
            placeholder={defaultSwatch}
            title={`Empty means the default (${defaultHint})`}
            aria-invalid={invalid ? true : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              const hex = normaliseHex(event.target.value);
              if (hex) onChange(hex);
              else if (event.target.value.trim() === "") onChange(null);
            }}
          />
          {value && (
            <button type="button" className="ui-link-button" onClick={() => onChange(null)}>
              Reset
            </button>
          )}
        </span>
      </span>
    </div>
  );
}

function Preview({
  mode,
  theme,
  name,
  initials,
  logoUrl,
}: {
  mode: Mode;
  theme: Theme;
  name: string;
  initials: string;
  logoUrl: string | null;
}) {
  const colours = previewColours(theme, mode);
  const style = {
    "--pv-canvas": colours.canvas,
    "--pv-surface": colours.surface,
    "--pv-border": colours.border,
    "--pv-text": colours.textPrimary,
    "--pv-text-2": colours.textSecondary,
    "--pv-text-3": colours.textTertiary,
    "--pv-accent": colours.accent,
    "--pv-primary": colours.primary600,
    "--pv-primary-dark": colours.primary700,
  } as CSSProperties;

  return (
    <div className="ui-bx-preview" style={style}>
      <div className="ui-bx-preview-label">{mode === "light" ? "Light mode" : "Dark mode"}</div>
      <div className="ui-bx-preview-bar">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="ui-bx-preview-mark" src={logoUrl} alt="" />
        ) : (
          <span className="ui-bx-preview-mark" aria-hidden="true">
            {initials}
          </span>
        )}
        <span>{name}</span>
      </div>
      <div className="ui-bx-preview-body">
        <div className="ui-bx-preview-card">
          <span className="ui-bx-preview-title">Chapter 6 test</span>
          <span className="ui-bx-preview-secondary">Class 10-A · Mathematics</span>
          <span className="ui-bx-preview-tertiary">Closes Thursday, 4:00 pm</span>
          <span className="ui-bx-preview-link">View results</span>
          <span className="ui-bx-preview-button">Start test</span>
        </div>
      </div>
    </div>
  );
}
