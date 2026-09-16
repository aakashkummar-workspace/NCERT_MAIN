import { getPlayer } from "@/core/attempts";
import { guardStudent } from "../../_lib/student";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * The paper as the student sees it.
 *
 * No answer key leaves here while the attempt is in progress — see the note in
 * core/attempts/getPlayer, and the test that serialises the whole payload and
 * greps it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const { id } = await params;
  const player = await getPlayer(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    id,
  );
  if (!player) return fail("NOT_FOUND", "We could not find that test.");

  return ok(player);
}
