import "server-only";
import type { Prisma } from "@prisma/client";
import { summarise, type Marked, type ScoreSummary } from "@/core/attempts/score";

/**
 * Recompute an attempt's totals from the answer rows as they now stand.
 *
 * Not re-marking: it never looks at an answer key. Marking already happened —
 * automatically at submission, or by a person afterwards — and this only adds
 * up what those decisions produced. Keeping the two apart matters, because a
 * function that re-marked on every save would silently overwrite a teacher's
 * judgement with the machine's the next time anything touched the attempt.
 *
 * Called after every manual mark, so the score a student sees and the score on
 * the class list are the same number at every moment in between.
 */
export async function rescoreAttempt(
  tx: Prisma.TransactionClient,
  attemptId: string,
  now = new Date(),
): Promise<ScoreSummary> {
  const answers = await tx.attemptAnswer.findMany({ where: { attemptId } });

  const marks: Marked[] = answers.map((answer) => ({
    isCorrect: answer.isCorrect,
    awardedMarks:
      answer.awardedMarks === null ? null : Number(answer.awardedMarks),
    maxMarks: Number(answer.maxMarks),
    reason: reasonOf(answer),
  }));

  const summary = summarise(marks);

  await tx.attempt.update({
    where: { id: attemptId },
    data: {
      rawScore: summary.rawScore,
      maxScore: summary.maxScore,
      percentage: summary.percentage,
      // The clock on the score, not on the sitting. A paper whose last written
      // answer was marked in December was scored in December, whatever the
      // machine decided in August.
      scoredAt: now,
    },
  });

  return summary;
}

/**
 * Why an answer stands where it does, reconstructed from what is stored.
 *
 * The distinction that has to survive: an answer with no marks because nobody
 * has looked at it, and an answer with no marks because the student wrote
 * nothing. Both are `awardedMarks: null`, and only one is waiting on a person.
 */
function reasonOf(answer: {
  response: unknown;
  awardedMarks: unknown;
  isCorrect: boolean | null;
  maxMarks: unknown;
}): Marked["reason"] {
  if (answer.awardedMarks === null) {
    return answer.response === null ? "unanswered" : "awaiting-marking";
  }
  const awarded = Number(answer.awardedMarks);
  if (awarded >= Number(answer.maxMarks)) return "correct";
  if (awarded <= 0) return "incorrect";
  return "partial";
}
