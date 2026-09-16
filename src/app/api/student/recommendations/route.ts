import { recommendations } from "@/core/practice";
import { guardStudent } from "../../_lib/student";
import { ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * What to practise next.
 *
 * Returns the refusal as data rather than an empty list: "we do not know enough
 * about you yet" and "you are on top of everything" are opposite facts, and a
 * screen handed `[]` for both would show the same encouraging nothing to a
 * student who has never sat a test and to one who is doing well.
 */
export async function GET() {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const result = await recommendations({
    organizationId: check.session.actor.organizationId,
    userId: check.session.actor.userId,
  });

  return ok(result);
}
