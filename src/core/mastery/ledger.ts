import "server-only";
import type { Prisma } from "@prisma/client";
import {
  estimateMastery,
  trendFor,
  type Difficulty,
  type Evidence,
} from "./estimate";

/**
 * Writing evidence, and turning it into an estimate.
 *
 * ---------------------------------------------------------------------------
 * When evidence appears
 * ---------------------------------------------------------------------------
 * The moment an answer is **marked**, not the moment it is submitted. An
 * objective answer is marked at submission and produces evidence immediately;
 * a written one produces nothing until a teacher reads it, and then produces
 * evidence dated to the day the student sat the paper.
 *
 * That distinction is the same "null is not zero" rule the marking layer is
 * built on, carried one level further. An unmarked answer counted as evidence
 * would be evidence of nothing, and counting it as a failure would let a
 * marking backlog look like a class that cannot do the work.
 *
 * ---------------------------------------------------------------------------
 * What produces no evidence at all
 * ---------------------------------------------------------------------------
 * - An unanswered question. Nobody learned anything about the student.
 * - A question with no learning outcome. It cannot be approved either, so this
 *   is belt and braces.
 * - An outcome that no concept covers. This one is worth stating plainly: the
 *   answer is scored, the student sees their marks, and it informs nothing.
 *   Concepts are authored by a person, and 64 of the 69 seeded outcomes do not
 *   have one yet. `conceptCoverage()` exists so that gap is visible rather than
 *   discovered as a blank analytics page six months from now.
 */

export type Actor = { organizationId: string; userId: string };

/**
 * Record the evidence from one attempt, and recompute everything it touched.
 *
 * Idempotent: re-marking an answer updates its evidence row rather than adding
 * a second one, so a teacher changing 1/3 to 2/3 does not leave the question
 * counted twice with two different verdicts.
 */
export async function recordAttemptEvidence(
  tx: Prisma.TransactionClient,
  organizationId: string,
  attemptId: string,
  now = new Date(),
): Promise<{ written: number; concepts: string[] }> {
  const attempt = await tx.attempt.findFirst({
    where: { id: attemptId },
    include: { answers: true },
  });
  if (!attempt) return { written: 0, concepts: [] };

  // A paper still being written is not evidence of anything yet.
  if (attempt.status === "IN_PROGRESS") return { written: 0, concepts: [] };

  const marked = attempt.answers.filter((answer) => answer.awardedMarks !== null);
  if (marked.length === 0) return { written: 0, concepts: [] };

  const placements = await tx.assessmentQuestion.findMany({
    where: { id: { in: marked.map((a) => a.assessmentQuestionId) } },
    include: { question: { select: { id: true, difficulty: true } } },
  });
  const placementById = new Map(placements.map((p) => [p.id, p]));

  const conceptsByQuestion = await conceptsForQuestions(
    tx,
    placements.map((p) => p.questionId),
  );

  // The day the student sat the paper, not the day it was marked. A December
  // marking session is not December evidence.
  const observedAt = attempt.submittedAt ?? attempt.startedAt;

  const touched = new Set<string>();
  let written = 0;

  for (const answer of marked) {
    const placement = placementById.get(answer.assessmentQuestionId);
    if (!placement) continue;

    const links = conceptsByQuestion.get(placement.questionId) ?? [];
    if (links.length === 0) continue;

    const maxMarks = Number(answer.maxMarks);
    // A zero-mark question cannot express a score. Treated as no evidence
    // rather than as a divide-by-zero dressed up as certainty.
    if (maxMarks <= 0) continue;
    const score = clamp(Number(answer.awardedMarks) / maxMarks, 0, 1);

    for (const link of links) {
      await tx.conceptEvidence.upsert({
        where: {
          attemptAnswerId_conceptId: {
            attemptAnswerId: answer.id,
            conceptId: link.conceptId,
          },
        },
        create: {
          organizationId,
          studentUserId: attempt.studentUserId,
          conceptId: link.conceptId,
          attemptAnswerId: answer.id,
          score,
          difficulty: placement.question.difficulty,
          weight: link.weight,
          observedAt,
        },
        update: { score, weight: link.weight, observedAt },
      });
      touched.add(link.conceptId);
      written++;
    }
  }

  for (const conceptId of touched) {
    await recomputeMastery(tx, organizationId, attempt.studentUserId, conceptId, now);
  }

  return { written, concepts: [...touched] };
}

/**
 * Re-derive one student's estimate for one concept from the ledger.
 *
 * Reads every row and re-runs the estimator rather than updating incrementally.
 * An incremental update cannot express recency decay — yesterday's estimate was
 * computed against yesterday's clock — and it would drift from what a
 * recomputation produces, which is the one property this table must never lose.
 */
export async function recomputeMastery(
  tx: Prisma.TransactionClient,
  organizationId: string,
  studentUserId: string,
  conceptId: string,
  now = new Date(),
): Promise<void> {
  const rows = await tx.conceptEvidence.findMany({
    where: { studentUserId, conceptId },
    orderBy: { observedAt: "asc" },
  });

  const evidence: Evidence[] = rows.map((row) => ({
    score: Number(row.score),
    difficulty: row.difficulty as Difficulty,
    mapping: Number(row.weight),
    observedAt: row.observedAt,
  }));

  const mastery = estimateMastery(evidence, now);

  const existing = await tx.studentConceptMastery.findUnique({
    where: { studentUserId_conceptId: { studentUserId, conceptId } },
  });

  const estimate = mastery.band === "INSUFFICIENT" ? null : mastery.estimate;
  const previous =
    existing?.estimate === null || existing?.estimate === undefined
      ? null
      : Number(existing.estimate);

  const data = {
    organizationId,
    studentUserId,
    conceptId,
    estimate,
    confidence: mastery.band === "INSUFFICIENT" ? null : mastery.confidence,
    evidenceCount: mastery.evidenceCount,
    effectiveEvidence: mastery.effectiveEvidence,
    band: mastery.band,
    // The estimate before this recomputation, so a trend compares like with
    // like. Carried forward untouched when there is nothing new to compare.
    previousEstimate: previous,
    trend: trendFor(estimate, previous),
    lastEvidenceAt: mastery.lastEvidenceAt,
    computedAt: now,
  };

  await tx.studentConceptMastery.upsert({
    where: { studentUserId_conceptId: { studentUserId, conceptId } },
    create: data,
    update: data,
  });
}

type ConceptLink = { conceptId: string; weight: number };

/**
 * Which concepts each question is evidence about, and how strongly.
 *
 * A question maps to outcomes; outcomes map to concepts. The weight is the
 * product of the two hops: a secondary outcome (0.4) covered by a concept at
 * 0.5 contributes 0.2. Where two outcomes on the same question reach the same
 * concept, the stronger link wins rather than the two adding up — a question
 * cannot be more than fully about one idea.
 */
async function conceptsForQuestions(
  tx: Prisma.TransactionClient,
  questionIds: string[],
): Promise<Map<string, ConceptLink[]>> {
  if (questionIds.length === 0) return new Map();

  const questionOutcomes = await tx.questionOutcome.findMany({
    where: { questionId: { in: questionIds } },
  });
  if (questionOutcomes.length === 0) return new Map();

  const conceptOutcomes = await tx.conceptOutcome.findMany({
    where: {
      learningOutcomeId: {
        in: [...new Set(questionOutcomes.map((qo) => qo.learningOutcomeId))],
      },
    },
  });

  const byOutcome = new Map<string, { conceptId: string; weight: number }[]>();
  for (const link of conceptOutcomes) {
    const list = byOutcome.get(link.learningOutcomeId) ?? [];
    list.push({ conceptId: link.conceptId, weight: Number(link.weight) });
    byOutcome.set(link.learningOutcomeId, list);
  }

  const result = new Map<string, ConceptLink[]>();
  for (const questionOutcome of questionOutcomes) {
    const concepts = byOutcome.get(questionOutcome.learningOutcomeId) ?? [];
    if (concepts.length === 0) continue;

    const strongest = new Map<string, number>(
      (result.get(questionOutcome.questionId) ?? []).map((link) => [
        link.conceptId,
        link.weight,
      ]),
    );

    for (const concept of concepts) {
      const weight = clamp(
        Number(questionOutcome.weight) * concept.weight,
        0,
        1,
      );
      strongest.set(
        concept.conceptId,
        Math.max(strongest.get(concept.conceptId) ?? 0, weight),
      );
    }

    result.set(
      questionOutcome.questionId,
      [...strongest].map(([conceptId, weight]) => ({ conceptId, weight })),
    );
  }

  return result;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
