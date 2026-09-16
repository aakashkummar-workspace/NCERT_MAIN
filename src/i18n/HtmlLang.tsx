"use client";

import { useEffect } from "react";

/**
 * Corrects `<html lang>` on a page that was rendered in another language.
 *
 * The root layout says `en-IN` because every surface but a translated one is
 * English whatever the browser asks for. A page that renders through the
 * translator places this with the locale it ACTUALLY used, so a screen reader
 * reads Hindi with a Hindi voice — and puts `en-IN` back when the reader leaves,
 * because the next page in a client navigation is English again.
 *
 * Deliberately not `server-only` and not in the barrel: it is a client
 * component, imported by path (`@/i18n/HtmlLang`) where it is used.
 */
export function HtmlLang({ lang }: { lang: string }) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("lang") ?? "en-IN";
    root.setAttribute("lang", lang);
    return () => root.setAttribute("lang", previous);
  }, [lang]);

  return null;
}
