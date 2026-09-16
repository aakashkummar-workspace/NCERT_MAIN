import { z } from "zod";
import { assignmentResults } from "@/core/results";
import { guard, notFound } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * What the class did with this paper.
 *
 * Every cohort figure is computed over fully marked papers only, and the count
 * left out travels with it — see the note at the top of core/results.
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
  const results = await assignmentResults(
    check.session.actor.organizationId,
    id,
  );
  if (!results) return notFound("assignment");

  return ok(results);
}
