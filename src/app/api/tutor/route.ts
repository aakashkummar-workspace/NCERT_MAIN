import { z } from "zod";
import { askForHelp } from "@/core/tutor";
import { guardStudent } from "../_lib/student";
import { fail, failValidation, ok } from "../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  questionId: z.string().uuid(),
  /** Where they asked from. Both optional — a question can be reached alone. */
  practiceAnswerId: z.string().uuid().nullish(),
  studentMistakeId: z.string().uuid().nullish(),
});

/**
 * Ask for help on a question.
 *
 * There is no `level` parameter, and that is deliberate. The level is a
 * function of what this student has already been given on this question: a
 * client that could ask for EXPLAIN first could skip the hint, which is the
 * whole ladder. Escalation is the server's decision, so the record of how much
 * help somebody needed cannot be falsified by the page they asked from.
 *
 * There is no `studentId` either, for the same reason the Mistake Bank has
 * none — `?studentId=` would be the first crack in a boundary this feature
 * depends on entirely.
 */
export async function POST(request: Request) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await askForHelp(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    {
      questionId: parsed.data.questionId,
      practiceAnswerId: parsed.data.practiceAnswerId ?? null,
      studentMistakeId: parsed.data.studentMistakeId ?? null,
    },
  );

  // 409 rather than 402 or 429: the request was well formed and the answer is
  // "not right now". The message carries the reason, and it is written for a
  // fifteen-year-old rather than for a billing page.
  //
  // `retryable` travels in the details so the panel can stop offering a button
  // that will only refuse again.
  if (!result.ok) {
    return fail("CONFLICT", result.message, { retryable: result.retryable });
  }

  return ok(result);
}
