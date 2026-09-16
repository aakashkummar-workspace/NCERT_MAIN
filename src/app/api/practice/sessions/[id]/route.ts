import { getPractice } from "@/core/practice";
import { guardStudent } from "../../../_lib/student";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * The set, at the versions served.
 *
 * An explanation and a correct answer appear on a question only once THAT
 * question has been answered. Per question, not per session: answering the
 * third must not hand over the answers to the rest.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const { id } = await params;
  const session = await getPractice(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    id,
  );
  if (!session) return fail("NOT_FOUND", "We could not find that.");

  return ok(session);
}
