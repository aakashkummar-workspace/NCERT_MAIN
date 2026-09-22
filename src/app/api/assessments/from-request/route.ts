import { z } from "zod";
import { draftPaperFromRequest } from "@/core/assessments/from-request";
import { guard } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";
// One model call and a few queries; the local Claude Code provider is slower.
export const maxDuration = 120;

const Body = z.object({ request: z.string().trim().min(1).max(600) });

/**
 * Draft a paper from a teacher's sentence. Returns a DRAFT's id and what was
 * built; nothing is published or assigned here.
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

  const result = await draftPaperFromRequest(check.session.actor, { request: parsed.data.request });
  if (!result.ok) {
    return fail(result.reason === "FORBIDDEN" ? "FORBIDDEN" : "VALIDATION_FAILED", result.message, {
      reason: result.reason,
    });
  }
  return ok(result);
}
