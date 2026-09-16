import { getSession, type SessionContext } from "@/core/identity/context";
import { fail } from "./respond";

/**
 * Parent guard.
 *
 * The role gets somebody as far as the door and no further — everything a
 * parent can actually read comes from a `ParentStudentLink`, checked per child
 * in `core/parent/read.ts`. A PARENT membership with no links sees an empty
 * list, which is the correct answer and not an error.
 *
 * A teacher hitting a parent route gets 404, not 403: there is no reason to
 * describe the shape of the parent API to somebody who is not one.
 */
export async function guardParent(): Promise<
  { ok: true; session: SessionContext } | { ok: false; response: Response }
> {
  const session = await getSession();
  if (!session || session.actor.role !== "PARENT") {
    return { ok: false, response: fail("NOT_FOUND", "We could not find that.") };
  }
  return { ok: true, session };
}
