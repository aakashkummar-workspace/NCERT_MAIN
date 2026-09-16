import "server-only";
import { withTenant } from "@/db/tenant";
import { recomputeMastery } from "@/core/mastery/ledger";

/**
 * Practice, on the evidence ledger.
 *
 * ---------------------------------------------------------------------------
 * Why it counts at all
 * ---------------------------------------------------------------------------
 * The obvious safe choice is to exclude it: practice is untimed, unwatched, and
 * has an explanation a tap away, so it is weaker evidence than a supervised
 * paper by every measure.
 *
 * But excluding it breaks the product's own North Star. `PRACTICE_SET` is an
 * intervention kind, and an intervention whose effect can never reach the
 * mastery figure can never be measured as having worked — which would mean the
 * one thing a teacher can set that a student will actually do at home is the
 * one thing the product refuses to give them credit for.
 *
 * ---------------------------------------------------------------------------
 * Why it counts for less
 * ---------------------------------------------------------------------------
 * At full weight, mastery becomes a function of persistence. A student could
 * work through enough practice to close their own learning gap — and a gap that
 * closed because somebody ground questions at home, possibly with the answer
 * open in another tab, is a gap the teacher stops teaching. That is a lesson
 * not taught, which is the most expensive failure this product has.
 *
 * 0.4 means roughly five practice questions carry what two exam questions do.
 * Enough for sustained work to move the number; not enough for an evening to.
 *
 * The number is a judgement and will be wrong at first. What makes that
 * survivable is that `source` is stamped on every row: when 0.4 turns out to be
 * 0.3, `rebuildMastery` re-derives every estimate in the system from evidence
 * that never moved. That is the entire reason the ledger is separate from the
 * estimate.
 *
 * ---------------------------------------------------------------------------
 * Written once, at the end
 * ---------------------------------------------------------------------------
 * Per-answer writes would let a student watch their own estimate move as they
 * worked, which turns practice into a slot machine. Evidence lands when the set
 * is finished, and an abandoned set contributes nothing — you do not get credit
 * for the four you answered before closing the tab on the fifth.
 *
 * ---------------------------------------------------------------------------
 * A helped answer is worth nothing here — not less, nothing
 * ---------------------------------------------------------------------------
 * The tutor exists so a stuck student can get moving again, and it must not
 * cost them anything to use. But an answer given after being walked through the
 * method says nothing whatsoever about what they can do alone, and mastery is a
 * claim about exactly that. Writing it at a reduced weight would be the worse
 * of the two options: a number that is a little bit wrong is harder to notice
 * than one that is absent, and this one ends up in front of a teacher deciding
 * whether to reteach.
 *
 * So it is dropped, and only for the question they were helped on. The rest of
 * the set still counts, and the help itself is never discouraged.
 */

/**
 * How much a practice answer counts against a supervised one.
 *
 * Multiplied into the concept-mapping weight the ledger already carries, so a
 * practice answer on a secondary outcome is weakened twice, which is right.
 */
export const PRACTICE_WEIGHT = 0.4;

export type PracticeEvidenceReport = {
  ok: boolean;
  written: number;
  concepts: number;
  /**
   * Answers dropped because the tutor had already helped on that question.
   *
   * Reported rather than silent: if this is most of a set, the student is
   * working entirely with help and their mastery figure is thinner than the
   * question count suggests — which is a thing somebody should be able to see.
   */
  skippedAsHelped: number;
  error?: string;
};

export async function recordPracticeEvidence(
  organizationId: string,
  sessionId: string,
  now = new Date(),
): Promise<PracticeEvidenceReport> {
  try {
    return await withTenant(organizationId, async (tx) => {
      const session = await tx.practiceSession.findFirst({
        where: { id: sessionId },
      });
      // Nothing for an abandoned set. Deliberate: crediting the four they
      // answered before closing the tab would reward starting over finishing.
      if (!session || session.completedAt === null) {
        return { ok: true, written: 0, concepts: 0, skippedAsHelped: 0 };
      }

      const answers = await tx.practiceAnswer.findMany({
        where: { practiceSessionId: sessionId, isCorrect: { not: null } },
      });
      if (answers.length === 0) {
        return { ok: true, written: 0, concepts: 0, skippedAsHelped: 0 };
      }

      const questions = await tx.question.findMany({
        where: { id: { in: answers.map((a) => a.questionId) } },
        select: { id: true, difficulty: true },
      });
      const difficultyByQuestion = new Map(
        questions.map((q) => [q.id, q.difficulty]),
      );

      const conceptsByQuestion = await conceptsForQuestions(
        tx,
        answers.map((a) => a.questionId),
      );

      // When they first asked for help on each of these questions, if ever.
      //
      // The timestamp matters: asking for help from the review screen AFTER
      // answering does not retrospectively void the answer they had already
      // given unaided. Only help that came first did the work.
      const helpedAt = new Map<string, Date>();
      const tutored = await tx.tutorSession.findMany({
        where: {
          studentUserId: session.studentUserId,
          questionId: { in: answers.map((a) => a.questionId) },
        },
        select: { questionId: true, createdAt: true },
      });
      for (const helped of tutored) helpedAt.set(helped.questionId, helped.createdAt);

      const touched = new Set<string>();
      let written = 0;
      let skippedAsHelped = 0;

      for (const answer of answers) {
        const helped = helpedAt.get(answer.questionId);
        if (helped && answer.answeredAt && helped <= answer.answeredAt) {
          skippedAsHelped++;
          continue;
        }

        const links = conceptsByQuestion.get(answer.questionId) ?? [];
        if (links.length === 0) continue;

        for (const link of links) {
          await tx.conceptEvidence.upsert({
            where: {
              practiceAnswerId_conceptId: {
                practiceAnswerId: answer.id,
                conceptId: link.conceptId,
              },
            },
            create: {
              organizationId,
              studentUserId: session.studentUserId,
              conceptId: link.conceptId,
              practiceAnswerId: answer.id,
              source: "PRACTICE",
              score: answer.isCorrect ? 1 : 0,
              difficulty: difficultyByQuestion.get(answer.questionId) ?? "MEDIUM",
              // The mapping weight, weakened. Both reductions apply.
              weight: link.weight * PRACTICE_WEIGHT,
              // When they answered, not when this ran — same rule as a paper.
              observedAt: answer.answeredAt ?? session.completedAt ?? now,
            },
            update: {},
          });
          touched.add(link.conceptId);
          written++;
        }
      }

      for (const conceptId of touched) {
        await recomputeMastery(
          tx,
          organizationId,
          session.studentUserId,
          conceptId,
          now,
        );
      }

      return { ok: true, written, concepts: touched.size, skippedAsHelped };
    });
  } catch (error) {
    // Swallowed, like every other ledger write. The student finished their
    // practice and saw every verdict; an estimate that updates late is a much
    // smaller failure than a runner that errors on the last question.
    console.error(
      `[practice] could not record evidence for session ${sessionId}:`,
      error,
    );
    return {
      ok: false,
      written: 0,
      concepts: 0,
      skippedAsHelped: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type ConceptLink = { conceptId: string; weight: number };

/**
 * Which concepts each question is evidence about, and how strongly.
 *
 * The same two-hop product the assessment ledger computes — question to
 * outcome, outcome to concept — kept here rather than exported from
 * `core/mastery/ledger.ts` because that module's copy is `tx`-bound to the
 * attempt path. Two short readers that agree beats one that both paths have to
 * bend around.
 */
async function conceptsForQuestions(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  questionIds: string[],
): Promise<Map<string, ConceptLink[]>> {
  if (questionIds.length === 0) return new Map();

  const links = await tx.questionOutcome.findMany({
    where: { questionId: { in: questionIds } },
    select: { questionId: true, learningOutcomeId: true, weight: true },
  });
  if (links.length === 0) return new Map();

  const conceptLinks = await tx.conceptOutcome.findMany({
    where: {
      learningOutcomeId: { in: [...new Set(links.map((l) => l.learningOutcomeId))] },
    },
    select: { conceptId: true, learningOutcomeId: true, weight: true },
  });

  const byOutcome = new Map<string, { conceptId: string; weight: number }[]>();
  for (const link of conceptLinks) {
    const list = byOutcome.get(link.learningOutcomeId) ?? [];
    list.push({ conceptId: link.conceptId, weight: Number(link.weight) });
    byOutcome.set(link.learningOutcomeId, list);
  }

  const result = new Map<string, ConceptLink[]>();
  for (const link of links) {
    const existing = result.get(link.questionId) ?? [];
    for (const concept of byOutcome.get(link.learningOutcomeId) ?? []) {
      const weight = Number(link.weight) * concept.weight;
      const already = existing.find((e) => e.conceptId === concept.conceptId);
      // Two outcomes reaching the same concept: the stronger link wins rather
      // than the two adding up, exactly as the assessment ledger decides it.
      if (already) {
        already.weight = Math.max(already.weight, weight);
      } else {
        existing.push({ conceptId: concept.conceptId, weight });
      }
    }
    result.set(link.questionId, existing);
  }
  return result;
}
