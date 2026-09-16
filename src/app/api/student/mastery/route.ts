import { studentMastery } from "@/core/mastery/read";
import { guardStudent } from "../../_lib/student";
import { ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * What a student's own answers say about each concept.
 *
 * `estimate` is null wherever `band` is INSUFFICIENT, and it is null because
 * the column is null — a number the estimator refused to produce is never
 * stored, so there is nothing here for a client to accidentally render.
 */
export async function GET() {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const mastery = await studentMastery(
    check.session.actor.organizationId,
    check.session.actor.userId,
  );

  return ok({ mastery });
}
