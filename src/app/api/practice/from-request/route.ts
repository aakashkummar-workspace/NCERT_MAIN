import { z } from "zod";
import { proposePracticeFromRequest } from "@/core/practice/from-request";
import { guard } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";
// One model call and a few queries; the local Claude Code provider is slower.
export const maxDuration = 120;

const Body = z.object({ request: z.string().trim().min(1).max(600) });

/**
 * Propose practice sets from a teacher's sentence. Writes nothing: the teacher
 * sets each one through POST /api/classes/[id]/practice, as by hand.
 */
export async function POST(request: Request) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await proposePracticeFromRequest(check.session.actor, { request: parsed.data.request });
  if (!result.ok) {
    return fail(result.reason === "FORBIDDEN" ? "FORBIDDEN" : "VALIDATION_FAILED", result.message, {
      reason: result.reason,
    });
  }
  return ok(result);
}
