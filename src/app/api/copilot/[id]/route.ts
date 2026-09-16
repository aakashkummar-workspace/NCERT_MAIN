import { z } from "zod";
import { getConversation } from "@/core/copilot";
import { guard } from "../../_lib/guard";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * One conversation.
 *
 * Scoped to the teacher's own user id on top of the tenant policy — a colleague
 * in the same organization has no business reading what somebody asked about a
 * class, and gets the same 404 as a stranger.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  // Malformed is missing: a 404, never a database error surfacing as a 500.
  if (!z.uuid().safeParse(id).success) return fail("NOT_FOUND", "We could not find that.");
  const conversation = await getConversation(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
  );
  if (!conversation) return fail("NOT_FOUND", "We could not find that.");

  return ok(conversation);
}
