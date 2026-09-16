import "server-only";
import { withTenant } from "@/db/tenant";

/**
 * Which bank question sits at each position of one of the student's OWN
 * sittings — for the "Save for later" control on the result review.
 *
 * `studentResult` builds its breakdown by naming each field and does not carry
 * a question id, and that is correct for what it is for. Saving needs the id,
 * so it is read here, keyed on the attempt AND the student: an attempt id from
 * a pasted URL that is not theirs maps to nothing, and nothing is offered.
 *
 * Returns ids only. The stems, options and keys the review shows still come
 * from `studentResult`, through its own gates.
 */
export async function resultQuestionIds(
  organizationId: string,
  studentUserId: string,
  attemptId: string,
): Promise<Map<number, string>> {
  return withTenant(organizationId, async (tx) => {
    const attempt = await tx.attempt.findFirst({
      where: { id: attemptId, studentUserId },
      select: { answers: { select: { assessmentQuestionId: true } } },
    });
    if (!attempt || attempt.answers.length === 0) return new Map();

    const placements = await tx.assessmentQuestion.findMany({
      where: { id: { in: attempt.answers.map((a) => a.assessmentQuestionId) } },
      select: { position: true, questionId: true },
    });
    return new Map(placements.map((row) => [row.position, row.questionId]));
  });
}
