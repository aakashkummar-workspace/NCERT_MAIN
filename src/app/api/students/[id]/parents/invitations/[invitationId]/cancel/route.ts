import { cancelParentInvitation } from "@/core/parent/link";
import { guard } from "../../../../../../_lib/guard";
import { fail, ok } from "../../../../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Stop an unaccepted parent invitation working.
 *
 * A POST that stamps, not a DELETE: the invitation row stays, because "was a
 * link ever sent to this number about this child" is still a fair question
 * after the link is dead.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; invitationId: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id, invitationId } = await params;
  const result = await cancelParentInvitation(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
    invitationId,
  );
  if (!result.ok) return fail("NOT_FOUND", result.message);

  return ok(result);
}
