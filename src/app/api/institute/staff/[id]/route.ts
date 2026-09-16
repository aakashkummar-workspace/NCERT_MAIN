import { z } from "zod";
import { changeRole, removeStaff } from "@/core/institute/members";
import { can } from "@/core/billing/entitlements";
import { guard } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ role: z.enum(["OWNER", "ADMIN", "TEACHER"]) });

async function gate(action: "member:update_role" | "member:remove") {
  const check = await guard(action);
  if (!check.ok) return check;
  const allowed = await can(check.session.actor.organizationId, "admin_console");
  if (!allowed.allowed) {
    return { ok: false as const, response: fail("NOT_FOUND", "We could not find that.") };
  }
  return check;
}

/** Change somebody's role. Refuses the last owner, and refuses yourself. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await gate("member:update_role");
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const { id } = await params;
  const result = await changeRole(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
    parsed.data.role,
  );
  if (!result.ok) return fail("CONFLICT", result.message);

  return ok(result);
}

/**
 * Take somebody's access away.
 *
 * DELETE on the route, SUSPENDED in the database. Nothing is deleted: their
 * papers and their marking point at them, and "who marked this" is a question
 * asked a year later.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await gate("member:remove");
  if (!check.ok) return check.response;

  const { id } = await params;
  const result = await removeStaff(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
  );
  if (!result.ok) return fail("CONFLICT", result.message);

  return ok(result);
}
