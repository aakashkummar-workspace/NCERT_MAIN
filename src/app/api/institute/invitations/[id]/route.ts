import { cancelInvite } from "@/core/institute/members";
import { can } from "@/core/billing/entitlements";
import { guard } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/** Cancel an invitation nobody has accepted. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("member:invite");
  if (!check.ok) return check.response;

  const allowed = await can(check.session.actor.organizationId, "admin_console");
  if (!allowed.allowed) return fail("NOT_FOUND", "We could not find that.");

  const { id } = await params;
  const result = await cancelInvite(
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
