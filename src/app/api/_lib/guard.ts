import { getSession, type SessionContext } from "@/core/identity/context";
import { can, type Action } from "@/core/identity/authorize";
import { fail } from "./respond";

/**
 * Route guard.
 *
 * Returns either the session or the response to send. There is no variant that
 * accepts an organization id — the tenant is always derived from the session,
 * never from anything the caller sent.
 */
export async function guard(
  action: Action,
): Promise<
  { ok: true; session: SessionContext } | { ok: false; response: Response }
> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: fail("UNAUTHENTICATED", "Please sign in and try again."),
    };
  }

  if (!can(session.actor, action)) {
    return {
      ok: false,
      response: fail(
        "FORBIDDEN",
        "Your account does not have permission to do that.",
      ),
    };
  }

  return { ok: true, session };
}

/**
 * A resource that exists but belongs to another tenant returns 404, not 403.
 * A 403 confirms the row exists, which is itself a leak.
 */
export function notFound(what: string) {
  return fail("NOT_FOUND", `We could not find that ${what}.`);
}
