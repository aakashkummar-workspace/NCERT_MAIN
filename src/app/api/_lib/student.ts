import { getSession, type SessionContext } from "@/core/identity/context";
import { fail } from "./respond";

/**
 * Student guard.
 *
 * The role comes from the session, like everything else. A teacher hitting a
 * student route gets 404 rather than 403 — there is no reason to describe the
 * shape of the student API to someone who is not one.
 */
export async function guardStudent(): Promise<
  { ok: true; session: SessionContext } | { ok: false; response: Response }
> {
  const session = await getSession();
  if (!session || session.actor.role !== "STUDENT") {
    return {
      ok: false,
      response: fail("NOT_FOUND", "We could not find that."),
    };
  }
  return { ok: true, session };
}
