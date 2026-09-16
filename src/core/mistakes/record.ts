import "server-only";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { isBlankResponse } from "@/core/attempts/response";
import { classify, type AnswerFacts } from "./classify";

/**
 * Turning a marked paper into a student's mistake bank.
 *
 * ---------------------------------------------------------------------------
 * A mistake is a SETTLED wrong answer
 * ---------------------------------------------------------------------------
 * The same discipline the marking layer and the mastery ledger are built on,
 * carried one step further. An unmarked written answer is not a mistake — it is
 * unmarked, and putting a student's own three paragraphs in front of them under
 * the heading "you got this wrong" before anybody has read them is the single
 * worst thing this feature could do.
 *
 * So an objective answer becomes a mistake at submission, and a written one
 * only when a person has marked it — at which point `awardMarks` runs this
 * again. A question with no answer key produces nothing at all: that is a hole
 * in the paper, not a hole in the student.
 *
 * ---------------------------------------------------------------------------
 * Dated to when it was SAT
 * ---------------------------------------------------------------------------
 * Same rule as the evidence ledger. A December marking session does not make a
 * September mistake a December one, and resolution compares against this date.
 *
 * ---------------------------------------------------------------------------
 * Idempotent, keyed on the answer
 * ---------------------------------------------------------------------------
 * `attemptAnswerId` is unique. Running the recorder twice on the same paper
 * updates the row rather than dealing the same card twice, and a teacher who
 * changes 1 out of 3 to 3 out of 3 removes the mistake instead of leaving a
 * stale one in the student's bank forever.
 */

export type RecordResult = {
  ok: boolean;
  recorded: number;
  cleared: number;
  /** How many need the nightly model pass. Zero is the good number. */
  pending: number;
  error?: string;
};

/** Types that mark themselves. Everything else waits for a person. */
const OBJECTIVE = new Set([
  "MCQ",
  "MULTI_SELECT",
  "TRUE_FALSE",
  "NUMERIC",
  "FILL_BLANK",
  "ASSERTION_REASON",
]);

export async function recordAttemptMistakes(
  organizationId: string,
  attemptId: string,
  now = new Date(),
): Promise<RecordResult> {
  try {
    return await withTenant(organizationId, (tx) =>
      record(tx, organizationId, attemptId, now),
    );
  } catch (error) {
    // Swallowed, deliberately, exactly as the mastery ledger is. The paper is
    // already committed and marked; a mistake bank that fills in late is a far
    // smaller failure than a submission that errors, and `rebuildMistakes`
    // re-derives the whole thing from answers that never moved.
    console.error(
      `[mistakes] could not record for attempt ${attemptId}:`,
      error,
    );
    return {
      ok: false,
      recorded: 0,
      cleared: 0,
      pending: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function record(
  tx: Prisma.TransactionClient,
  organizationId: string,
  attemptId: string,
  now: Date,
): Promise<RecordResult> {
  const attempt = await tx.attempt.findFirst({
    where: { id: attemptId },
    include: { answers: true },
  });
  if (!attempt) return { ok: true, recorded: 0, cleared: 0, pending: 0 };

  // A paper still being written is not a mistake bank. A student mid-exam
  // seeing their wrong answers listed would be the worst possible bug here.
  if (attempt.status === "IN_PROGRESS") {
    return { ok: true, recorded: 0, cleared: 0, pending: 0 };
  }

  const placements = await tx.assessmentQuestion.findMany({
    where: { id: { in: attempt.answers.map((a) => a.assessmentQuestionId) } },
    include: {
      question: {
        select: { id: true, type: true, expectedTimeSeconds: true },
      },
    },
  });
  const placementById = new Map(placements.map((p) => [p.id, p]));

  const conceptByQuestion = await primaryConceptFor(
    tx,
    placements.map((p) => p.questionId),
  );

  // What they could do at the time, per concept. The CARELESS rule needs it:
  // a wrong answer on something they can demonstrably do is a slip, and the
  // same answer without that evidence is not.
  const mastery = await tx.studentConceptMastery.findMany({
    where: {
      studentUserId: attempt.studentUserId,
      conceptId: { in: [...new Set([...conceptByQuestion.values()])] },
    },
    select: { conceptId: true, estimate: true },
  });
  const estimateByConcept = new Map(
    mastery.map((row) => [
      row.conceptId,
      row.estimate === null ? null : Number(row.estimate),
    ]),
  );

  const occurredAt = attempt.submittedAt ?? attempt.startedAt;
  // Both are the clock beating them. SWEEP is the one where the page was
  // already closed, which makes every unanswered question on that paper a
  // statement about the clock rather than about the student.
  const ranOutOfTime =
    attempt.submitReason === "TIMEOUT" || attempt.submitReason === "SWEEP";

  let recorded = 0;
  let cleared = 0;
  let pending = 0;

  for (const answer of attempt.answers) {
    const placement = placementById.get(answer.assessmentQuestionId);
    if (!placement) continue;

    const objective = OBJECTIVE.has(placement.question.type);
    const maxMarks = Number(answer.maxMarks);
    const awarded = answer.awardedMarks === null ? null : Number(answer.awardedMarks);
    // Whitespace and an empty selection are blanks too, for rows saved before
    // the player normalised them.
    const responded = !isBlankResponse(answer.response);

    // Is this settled? An objective question settles at submission — including
    // a blank one, which is a fact about the student, not a marking backlog.
    // A written one settles only when somebody has marked it.
    const settled = objective
      ? awarded !== null || !responded
      : answer.gradedAt !== null && awarded !== null;

    if (!settled) continue;

    // No key, no verdict. That is a hole in the paper, not in the student, and
    // recording it would tell somebody they were wrong about a question that
    // could not be marked either way.
    if (objective && responded && awarded === null) continue;
    if (maxMarks <= 0) continue;

    const fullMarks = awarded !== null && awarded >= maxMarks;

    if (fullMarks) {
      // They got it right — including on a re-mark that raised a previous
      // mistake to full marks. Delete rather than leave it sitting in their
      // bank, which would be the product arguing with the teacher.
      const removed = await tx.studentMistake.deleteMany({
        where: { attemptAnswerId: answer.id },
      });
      cleared += removed.count;
      continue;
    }

    const conceptId = conceptByQuestion.get(placement.questionId) ?? null;

    const facts: AnswerFacts = {
      responded,
      timeSpentSeconds: answer.timeSpentSeconds,
      expectedTimeSeconds: placement.question.expectedTimeSeconds,
      secondsBeforeSubmit:
        answer.answeredAt && attempt.submittedAt
          ? Math.round(
              (attempt.submittedAt.getTime() - answer.answeredAt.getTime()) / 1000,
            )
          : null,
      ranOutOfTime,
      visitCount: answer.visitCount,
      conceptEstimate: conceptId ? (estimateByConcept.get(conceptId) ?? null) : null,
      hasWriting: hasWriting(answer.response),
      type: placement.question.type,
    };

    const verdict = classify(facts);
    if (verdict.source === "PENDING") pending++;

    await tx.studentMistake.upsert({
      where: { attemptAnswerId: answer.id },
      create: {
        organizationId,
        studentUserId: attempt.studentUserId,
        attemptAnswerId: answer.id,
        questionId: placement.questionId,
        questionVersionId: answer.questionVersionId,
        conceptId,
        mistakeType: verdict.type,
        typeSource: verdict.source,
        typeReason: verdict.reason,
        occurredAt,
      },
      // Re-marking may change the type — a written answer that scored 0 and is
      // now 1 of 3 is a different mistake. Status and retry history are NOT
      // touched: those are the student's, and a teacher's second look at the
      // marking must not erase them.
      update: {
        mistakeType: verdict.type,
        typeSource: verdict.source,
        typeReason: verdict.reason,
        conceptId,
        occurredAt,
      },
    });
    recorded++;
  }

  void now;
  return { ok: true, recorded, cleared, pending };
}

/** Did they write something, or only pick something? */
function hasWriting(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const value = response as Record<string, unknown>;
  return value.kind === "text" && String(value.value ?? "").trim().length > 0;
}

/**
 * The single concept a question is most about.
 *
 * The mastery ledger spreads one answer across every concept the question
 * touches, weighted — that is right for an estimate. A mistake needs one
 * heading, because "this mistake is about four concepts" is not something a
 * student can act on. The strongest link wins.
 */
async function primaryConceptFor(
  tx: Prisma.TransactionClient,
  questionIds: string[],
): Promise<Map<string, string>> {
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

  const conceptsByOutcome = new Map<string, { conceptId: string; weight: number }[]>();
  for (const link of conceptLinks) {
    const list = conceptsByOutcome.get(link.learningOutcomeId) ?? [];
    list.push({ conceptId: link.conceptId, weight: Number(link.weight) });
    conceptsByOutcome.set(link.learningOutcomeId, list);
  }

  const best = new Map<string, { conceptId: string; weight: number }>();
  for (const link of links) {
    for (const concept of conceptsByOutcome.get(link.learningOutcomeId) ?? []) {
      const weight = Number(link.weight) * concept.weight;
      const current = best.get(link.questionId);
      if (!current || weight > current.weight) {
        best.set(link.questionId, { conceptId: concept.conceptId, weight });
      }
    }
  }

  return new Map([...best].map(([questionId, hit]) => [questionId, hit.conceptId]));
}

/**
 * Re-derive one student's whole bank from answers that never moved.
 *
 * The other half of the promise made by swallowing errors above, and the same
 * property the mastery ledger has: the bank is derived, so a failed write is
 * recoverable and a changed classifier can be applied to history without
 * anybody hand-editing rows.
 */
export async function rebuildMistakes(
  organizationId: string,
  studentUserId: string,
  now = new Date(),
): Promise<{ attempts: number; recorded: number }> {
  const attempts = await withTenant(organizationId, (tx) =>
    tx.attempt.findMany({
      where: { studentUserId, status: { not: "IN_PROGRESS" } },
      select: { id: true },
    }),
  );

  let recorded = 0;
  for (const attempt of attempts) {
    const outcome = await recordAttemptMistakes(organizationId, attempt.id, now);
    recorded += outcome.recorded;
  }
  return { attempts: attempts.length, recorded };
}
