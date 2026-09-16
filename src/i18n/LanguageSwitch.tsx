"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LOCALES, LOCALE_NAME, type Locale } from "./locales";
import { createTranslator } from "./translate";
import { useLocale } from "./LocaleContext";

/**
 * English / हिन्दी, for a signed-in person.
 *
 * Two real buttons with `aria-pressed`, not a select: there are two choices,
 * both fit on a phone bar, and each is one tap instead of three. Each is
 * labelled in its OWN language — somebody who cannot read the interface
 * cannot read "Hindi" either — and carries `lang` so a screen reader says
 * हिन्दी with a Hindi voice.
 *
 * The choice is stored against the account (`PATCH /api/me/locale/`), then the
 * page re-renders on the server, where the resolver now finds a stored
 * preference and uses it. Nothing is kept in the browser: a student on a
 * shared handset gets their own language back at sign-in, and the next person
 * on that phone does not inherit it.
 *
 * The hint beside it is not decoration. The seam translates the interface and
 * never the curriculum, and a student who switches and then meets an English
 * question should already have been told that, not left to think the switch
 * half-worked.
 */
export function LanguageSwitch() {
  const current = useLocale();
  const t = createTranslator(current);
  const router = useRouter();
  const [saving, setSaving] = useState<Locale | null>(null);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();

  async function choose(locale: Locale) {
    if (locale === current || saving) return;
    setSaving(locale);
    setFailed(false);
    try {
      const response = await fetch("/api/me/locale/", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      if (!response.ok) {
        setFailed(true);
        setSaving(null);
        return;
      }
      startTransition(() => {
        router.refresh();
        setSaving(null);
      });
    } catch {
      setFailed(true);
      setSaving(null);
    }
  }

  return (
    <div className="ui-sd-lang">
      <div className="ui-sd-lang-buttons" role="group" aria-label={t("student.language.label")}>
        {LOCALES.map((locale) => (
          <button
            key={locale}
            type="button"
            lang={locale}
            className="ui-sd-lang-button"
            aria-pressed={locale === current}
            aria-busy={saving === locale || undefined}
            onClick={() => choose(locale)}
          >
            {LOCALE_NAME[locale]}
          </button>
        ))}
      </div>
      <span className="ui-sd-lang-hint" lang={current} aria-live="polite">
        {failed ? t("student.language.failed") : t("student.language.hint")}
      </span>
    </div>
  );
}
