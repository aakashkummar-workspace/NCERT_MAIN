import "server-only";
import { headers } from "next/headers";
import { htmlLang, type Locale } from "./locales";
import { resolveLocale } from "./resolve";

/**
 * The request-side half of the seam: reads `Accept-Language` and hands back a
 * locale.
 *
 * Kept OUT of `src/i18n/index.ts` on purpose. This module imports
 * `next/headers` and `server-only`, and a client component that pulled the
 * barrel in would fail the build with an error about a server module rather
 * than about the button it was trying to translate. The catalogs, `t()` and
 * the formatters are all isomorphic and live in the barrel; only this file is
 * server-bound.
 *
 * ---------------------------------------------------------------------------
 * Why `stored` is an argument and not a lookup
 * ---------------------------------------------------------------------------
 * The first rung of the precedence is `User.locale`, which means the session,
 * which lives in `@/core/identity/context` — and `src/i18n` may not import
 * `@/core`. So the caller, which is a page and already has the session in
 * hand, passes it down. That keeps this folder importable from anywhere and
 * keeps the rule in CLAUDE.md structural rather than remembered.
 *
 * ---------------------------------------------------------------------------
 * Where the stored value comes from
 * ---------------------------------------------------------------------------
 * `SessionContext.locale`, which `app_auth_resolve_session` now selects. The
 * student surface passes it from `/student/layout.tsx` (and the home page), so a
 * signed-in student's own choice wins over the handset. A signed-out screen —
 * the sign-in form — passes nothing, and the header rung answers, because
 * there is no account to read a preference from yet.
 */

/**
 * The locale for this request.
 *
 * Note for the caller: reading a request header opts the route into dynamic
 * rendering. Every surface in this product that shows a person's own data is
 * already dynamic — it reads the session cookie — so this costs nothing there.
 * A genuinely static page that starts calling it stops being static.
 */
export async function requestLocale(stored?: string | null): Promise<Locale> {
  const store = await headers();
  return resolveLocale({
    stored,
    acceptLanguage: store.get("accept-language"),
  });
}

/**
 * The value for `<html lang>` on this request.
 *
 * A wrapper rather than something the layout composes itself, so that the one
 * line in `app/layout.tsx` stays one line — and so the day `lang` and the
 * locale tag stop being the same string, the layout does not have to change
 * again.
 */
export async function requestHtmlLang(stored?: string | null): Promise<string> {
  return htmlLang(await requestLocale(stored));
}
