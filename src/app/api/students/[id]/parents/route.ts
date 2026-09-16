import { z } from "zod";
import { inviteParent, linksForStudent } from "@/core/parent/link";
import { guard } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  phone: z.string().min(10).max(15),
  relationship: z.enum(["FATHER", "MOTHER", "GUARDIAN"]),
});

/** Who can currently see this child, for the teacher responsible for them. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const links = await linksForStudent(check.session.actor.organizationId, id);
  return ok({ links });
}

/**
 * Invite a parent to one named student.
 *
 * A parent is never invited to an organization in general — the invitation
 * carries the child, and accepting creates exactly that one edge. The token is
 * returned once here, for sending; only its hash is stored.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const { id } = await params;
  const result = await inviteParent(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    { studentUserId: id, ...parsed.data },
  );
  if (!result.ok) return fail("NOT_FOUND", result.message);

  return ok(result, { status: 201 });
}
