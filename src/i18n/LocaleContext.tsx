"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_LOCALE, type Locale } from "./locales";

/**
 * The locale a signed-in surface resolved, handed to the client components
 * inside it.
 *
 * Why a context and not a prop: the student bar is drawn by `StudentShell`,
 * which a dozen pages render, and threading a locale through every one of
 * them means the thirteenth page forgets and shows the English bar to a
 * student who chose Hindi. The layout resolves the locale ONCE — stored
 * preference first, then the header — and anything under it reads the same
 * answer. Same argument as gating a surface in its layout rather than in each
 * page.
 *
 * Isomorphic in what it carries: a `Locale` string and nothing that reads the
 * request. Resolving it is `./server`'s job.
 */
const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}
