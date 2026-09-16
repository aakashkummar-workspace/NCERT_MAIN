import { z } from "zod";
import { markingQueue } from "@/core/results/marking";
import { guard, notFound } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Everything on this assignment that needs a person, grouped by question
 * rather than by student. See the note in core/results/marking.
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
  const queue = await markingQueue(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
  );
  if (!queue) return notFound("assignment");

  return ok(queue);
}
