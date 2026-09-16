import { z } from "zod";
import { acknowledgeGap } from "@/core/gaps/read";
import { guard } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Say you have seen it.
 *
 * There is deliberately no counterpart that closes a gap. A gap resolves when
 * the evidence resolves it — a teacher who could dismiss one would be keeping a
 * tidy dashboard rather than teaching a concept, and the number on it would
 * stop meaning anything within a term.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  // Malformed is missing: a 404, never a database error surfacing as a 500.
  if (!z.uuid().safeParse(id).success) return fail("NOT_FOUND", "We could not find that.");
  const result = await acknowledgeGap(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    id,
  );
  if (!result.ok) return fail("NOT_FOUND", result.message);

  return ok(result);
}
