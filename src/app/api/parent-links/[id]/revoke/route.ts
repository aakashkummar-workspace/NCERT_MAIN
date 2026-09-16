import { revokeLink } from "@/core/parent/link";
import { guard } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Take a parent's access away.
 *
 * A stamp, never a delete — "who could see this child's results, and until
 * when" is a question that gets asked after something has gone wrong, and a
 * deleted row cannot answer it.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const result = await revokeLink(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
  );
  if (!result.ok) return fail("NOT_FOUND", result.message);

  return ok(result);
}
