import { z } from "zod";
import { measureIntervention } from "@/core/gaps/interventions";
import { guard } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Read the current mastery and record it against the stamp.
 *
 * There is no body, and deliberately no way to supply the outcome figure. A
 * measurement a teacher could type in is a measurement, and this one has to be
 * read off the evidence to be worth anything.
 *
 * There is also no counterpart that un-measures. A result that can be re-taken
 * until it is flattering is not a result — and a measured failure is the most
 * valuable row in this table.
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
  const result = await measureIntervention(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
  );
  if (!result.ok) return fail(result.reason, result.message);

  return ok(result);
}
