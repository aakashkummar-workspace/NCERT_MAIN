import { z } from "zod";
import { inviteStaff } from "@/core/institute/members";
import { can } from "@/core/billing/entitlements";
import { guard } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().email(),
  role: z.enum(["OWNER", "ADMIN", "TEACHER"]),
});

/**
 * Invite a colleague.
 *
 * Guarded twice, as the console itself is: `member:invite` says the acting user
 * may, and `admin_console` says the organization's plan includes this at all.
 * Neither implies the other — a solo teacher on Free is an OWNER with the
 * permission and no console to use it in.
 */
export async function POST(request: Request) {
  const check = await guard("member:invite");
  if (!check.ok) return check.response;

  const allowed = await can(check.session.actor.organizationId, "admin_console");
  if (!allowed.allowed) return fail("NOT_FOUND", "We could not find that.");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await inviteStaff(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    parsed.data,
  );
  if (!result.ok) return fail("CONFLICT", result.message);

  return ok(result, { status: 201 });
}
