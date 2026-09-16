import { z } from "zod";
import { itemAnalysis } from "@/core/results";
import { guard, notFound } from "../../../../_lib/guard";
import { fail, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Item analysis: how the class did on each question.
 *
 * The interesting column is not the facility index but `topDistractor` — the
 * wrong option more students chose than the right one. That names the specific
 * misconception rather than reporting that a question was hard.
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
  const analysis = await itemAnalysis(check.session.actor.organizationId, id);
  if (!analysis) return notFound("assignment");

  return ok(analysis);
}
