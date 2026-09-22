import { z } from "zod";
import { setPaperReview } from "@/core/assessments/review";
import { guard } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ required: z.boolean() });

/** Turn "papers are checked before publishing" on or off. */
export async function POST(request: Request) {
  const check = await guard("organization:update");
  if (!check.ok) return check.response;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const result = await setPaperReview(check.session.actor, parsed.data.required);
  if (!result.ok) return fail("FORBIDDEN", result.message);
  return ok({ required: parsed.data.required });
}
