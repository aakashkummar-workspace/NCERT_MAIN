import { z } from "zod";
import { releaseResults } from "@/core/results";
import { guard } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Release results to the class.
 *
 * Idempotent: pressing it twice returns the first release time with 200. It is
 * also permitted while marking is outstanding, and says how many papers that
 * is — holding twenty students back for four unmarked papers helps nobody, and
 * those four already see exactly what they are still owed.
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
  const result = await releaseResults(
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
