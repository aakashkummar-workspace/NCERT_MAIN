import { getMistake } from "@/core/mistakes/read";
import { guardStudent } from "../../../_lib/student";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * One mistake, at the version the student was served.
 *
 * The explanation and the correct answer are withheld until they have retried.
 * A mistake bank that opens with the answer showing is a reading exercise; the
 * value is in having one more go at it first.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const { id } = await params;
  const mistake = await getMistake(
    check.session.actor.organizationId,
    check.session.actor.userId,
    id,
  );
  if (!mistake) return fail("NOT_FOUND", "We could not find that.");

  return ok(mistake);
}
