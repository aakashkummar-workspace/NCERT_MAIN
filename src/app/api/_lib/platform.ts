import { getSession, type SessionContext } from "@/core/identity/context";
import { fail } from "./respond";

/**
 * Platform-admin guard.
 *
 * `isPlatformAdmin` comes from the session row, like everything else — never
 * from a header or a body a caller could set.
 *
 * A non-admin gets 404, not 403: a 403 confirms the platform console exists at
 * this path, and there is no reason to tell someone probing for it.
 */
export async function guardPlatform(): Promise<
  { ok: true; session: SessionContext } | { ok: false; response: Response }
> {
  const session = await getSession();
  if (!session || !session.isPlatformAdmin) {
    return {
      ok: false,
      response: fail("NOT_FOUND", "We could not find that page."),
    };
  }
  return { ok: true, session };
}
