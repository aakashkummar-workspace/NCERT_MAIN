import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { resolveSession } from "@/db/unscoped";
import type { Actor, Role } from "./authorize";
import { SESSION_COOKIE, hashToken } from "./session";

/**
 * Resolves the acting principal from the session cookie.
 *
 * ---------------------------------------------------------------------------
 * The rule this file exists to make unavoidable
 * ---------------------------------------------------------------------------
 * There is no overload of this function that accepts an organization id, and
 * there is deliberately no way to pass one. Organization and role are derived
 * from the session on every request, never read from a request body, query
 * string or header.
 *
 * A prior specification for a similar product read the acting user out of
 * `req.body`. That is an impersonation hole with a friendly name, and the only
 * reliable defence is an API that cannot express it.
 */

export type SessionContext = {
  actor: Actor;
  sessionId: string;
  fullName: string;
  organizationName: string;
  expiresAt: Date;
  /// Cross-tenant reach. Read from the session, like everything else — never
  /// from a header a caller could set.
  isPlatformAdmin: boolean;
  /// The stored interface language. Outranks the browser's header, because a
  /// student signing in on a borrowed phone gets their own choice back.
  locale: string | null;
};

/**
 * Memoised per request with React `cache`.
 *
 * A signed-in page asks for the session from its `generateMetadata`, its
 * surface layout and the page itself, and the database is a network hop away:
 * three identical lookups cost three round trips before any page work starts.
 * The memo lives for one server render and is discarded with it, so nothing
 * crosses requests. Outside a render (route handlers) `cache` does not
 * memoise, which keeps sign-in and sign-out reading the session fresh.
 */
export const getSession = cache(resolveSessionContext);

async function resolveSessionContext(): Promise<SessionContext | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  const row = await resolveSession(hashToken(raw));
  if (!row) return null;

  return {
    actor: {
      userId: row.user_id,
      organizationId: row.organization_id,
      membershipId: row.membership_id,
      role: row.role as Role,
    },
    sessionId: row.session_id,
    fullName: row.full_name,
    organizationName: row.organization_name,
    expiresAt: row.expires_at,
    isPlatformAdmin: row.platform_admin === true,
    locale: row.locale ?? null,
  };
}

/** For routes and pages that must have a session. */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) throw new UnauthenticatedError();
  return session;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "UnauthenticatedError";
  }
}
