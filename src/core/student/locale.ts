import "server-only";
import { withTenant } from "@/db/tenant";
import { isLocale, type Locale } from "@/i18n";

/**
 * Store the interface language a person chose for themselves.
 *
 * The first rung of the locale resolver (`src/i18n/resolve.ts`): a stored
 * choice outranks the handset's `Accept-Language`, because a student on a
 * borrowed phone should get their own language back at the next sign-in rather
 * than whatever the phone was set up in.
 *
 * Their OWN row and nobody else's: the user id comes from the session, never
 * from a request, and there is no parameter that names another person. The
 * `users` UPDATE policy (`user_modify` in rls.sql) admits a row with a
 * membership in the current organization, which the signed-in user always has;
 * the id in the WHERE is what narrows it to them.
 *
 * `updateMany` rather than `update`: Postgres applies the SELECT policy to
 * UPDATE ... RETURNING as well, and a count is all this needs.
 *
 * It changes the interface only. Questions, options and concept names stay in
 * English whatever this says — see the note at the top of `src/i18n/index.ts`.
 */
export async function setOwnLocale(
  actor: { organizationId: string; userId: string },
  locale: string,
): Promise<{ ok: true; locale: Locale } | { ok: false }> {
  if (!isLocale(locale)) return { ok: false };
  const updated = await withTenant(actor.organizationId, (tx) =>
    tx.user.updateMany({ where: { id: actor.userId }, data: { locale } }),
  );
  return updated.count === 1 ? { ok: true, locale } : { ok: false };
}
