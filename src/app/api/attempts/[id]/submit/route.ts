import { z } from "zod";
import { submitAttempt } from "@/core/attempts";
import { guardStudent } from "../../../_lib/student";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  reason: z.enum(["MANUAL", "TIMEOUT"]).default("MANUAL"),
});

/**
 * Submit.
 *
 * Idempotent: a retry returns the FIRST result with 200 and an
 * `alreadySubmitted` flag — not a 409. The client that retried did nothing
 * wrong, and telling it otherwise is how a student ends up staring at an error
 * page holding a finished paper.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const { id } = await params;

  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // An empty body is fine — a beacon on page-unload sends nothing.
  }

  const parsed = Body.safeParse(raw ?? {});
  if (!parsed.success) return failValidation(parsed.error);

  const result = await submitAttempt(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    id,
    parsed.data.reason,
  );

  if (!result.ok) return fail("NOT_FOUND", result.message);

  return ok({
    alreadySubmitted: result.alreadySubmitted,
    // Only sent when the teacher's policy allows it. A score that must not be
    // displayed is a score that should not be transmitted.
    ...(result.showResult
      ? {
          rawScore: result.rawScore,
          maxScore: result.maxScore,
          percentage: result.percentage,
          provisional: result.provisional,
        }
      : {}),
    showResult: result.showResult,
  });
}
