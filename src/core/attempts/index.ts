import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { syncAttemptMastery } from "@/core/mastery/sync";
import { recordAttemptMistakes } from "@/core/mistakes/record";
import { reconcileResolved } from "@/core/mistakes/read";
import { syncGapsForAttempt } from "@/core/gaps/sync";
import { writeAudit } from "@/core/identity/audit";
import { canStart } from "@/core/assignments/window";
import type { AnswerKey, Option, QuestionType } from "@/core/questions/validate";
import { markAnswer, summarise, type Response } from "./score";
import { isBlankResponse, normaliseResponse } from "./response";
import { alternativesToDrop, displayNumbers } from "@/core/assessments/pattern";

/**
 * Attempts: the student's sitting.
 *
 * This is the highest-stakes path in the product. Thirty students press Submit
 * in the same second, in a computer lab, on poor wifi, on inexpensive Android
 * phones. Four properties hold, and everything else is arranged around them:
 *
 *   1. **The clock is derived.** `startedAt + durationMs`, stamped by the
 *      server. A phone that backgrounds the tab for forty minutes comes back
 *      with the correct remaining time. A counted clock does not.
 *   2. **Starting is idempotent** on `clientAttemptId`, which the client
 *      generates before it has ever reached the network. Tapping Start twice
 *      on a flaky connection must not create two sittings.
 *   3. **Answers are idempotent and ordered.** Last write wins per question by
 *      `clientSeq`, so a batch that arrives late after a reconnect cannot
 *      overwrite a newer answer with an older one.
 *   4. **Submitting is idempotent.** A retry returns the first result with
 *      200, not a 409 — the client that retried did nothing wrong.
 *
 * And the rule that governs what leaves this module: **the answer key never
 * goes out while an attempt is in progress.** Not hidden in the UI, not
 * filtered in a component: absent from the payload.
 */

export type StudentActor = { organizationId: string; userId: string };

export type StartResult =
  | { ok: true; attemptId: string; resumed: boolean }
  | {
      ok: false;
      code: "NOT_FOUND" | "CLOSED" | "NO_ATTEMPTS_LEFT" | "CONFLICT";
      message: string;
    };

export async function startAttempt(
  actor: StudentActor,
  assignmentId: string,
  clientAttemptId: string,
): Promise<StartResult> {
  const now = new Date();

  return withTenant<StartResult>(actor.organizationId, async (tx) => {
    const assignment = await tx.assignment.findFirst({
      where: { id: assignmentId },
      include: {
        assessment: { select: { durationMinutes: true, status: true } },
        targets: { select: { studentUserId: true } },
      },
    });
    if (!assignment) {
      return { ok: false, code: "NOT_FOUND", message: "We could not find that test." };
    }

    // Is this student even meant to sit it? An empty target list means the
    // whole class, so membership of the class is what decides.
    const enrolled = await tx.classEnrolment.findFirst({
      where: {
        classId: assignment.classId,
        studentUserId: actor.userId,
        status: "ACTIVE",
      },
    });
    const targeted =
      assignment.targets.length === 0 ||
      assignment.targets.some((t) => t.studentUserId === actor.userId);

    if (!enrolled || !targeted) {
      // 404-shaped: no reason to confirm the test exists to someone who is not
      // meant to sit it.
      return { ok: false, code: "NOT_FOUND", message: "We could not find that test." };
    }

    // Sat on paper in the room: there is no sitting to start here, and a
    // second, online sitting of the same paper would leave the teacher two
    // answers to one paper and no way to say which counts.
    if (assignment.deliveryMode === "PAPER") {
      return {
        ok: false,
        code: "CLOSED",
        message: "This test is sat on paper in class. Your teacher records it.",
      };
    }

    // Resume before anything else: the same client id means the same sitting.
    const existing = await tx.attempt.findFirst({
      where: {
        assignmentId,
        studentUserId: actor.userId,
        clientAttemptId,
      },
    });
    if (existing) {
      return { ok: true, attemptId: existing.id, resumed: true };
    }

    // An unfinished sitting is resumed even if the client lost its id — a
    // student whose phone cleared its storage mid-test must get their paper
    // back, not a second one.
    const openOne = await tx.attempt.findFirst({
      where: {
        assignmentId,
        studentUserId: actor.userId,
        status: "IN_PROGRESS",
      },
    });
    if (openOne) {
      return { ok: true, attemptId: openOne.id, resumed: true };
    }

    if (!canStart(assignment, now)) {
      return {
        ok: false,
        code: "CLOSED",
        message: "This test is not open right now.",
      };
    }

    const used = await tx.attempt.count({
      where: { assignmentId, studentUserId: actor.userId },
    });
    if (used >= assignment.maxAttempts) {
      return {
        ok: false,
        code: "NO_ATTEMPTS_LEFT",
        message:
          used === 1
            ? "You have already taken this test."
            : `You have used all ${assignment.maxAttempts} attempts.`,
      };
    }

    const durationMinutes =
      assignment.durationOverrideMinutes ?? assignment.assessment.durationMinutes;
    const durationMs = durationMinutes * 60_000;

    // The window can close before the paper's own duration runs out. The
    // sitting ends at whichever comes first, so nobody is handed time they
    // could not use.
    const naturalEnd = new Date(now.getTime() + durationMs);
    const expiresAt =
      naturalEnd < assignment.closesAt ? naturalEnd : assignment.closesAt;

    const attemptId = randomUUID();

    // `createMany` with `skipDuplicates`, not `create`, and that is the whole
    // point of this block.
    //
    // The check above reads for an existing sitting and then inserts, with
    // nothing between the two. Two requests that overlap — a double tap on a
    // flaky connection, which is EXACTLY what `clientAttemptId` exists to
    // survive — both found nothing and both inserted. The unique index did its
    // job and refused the second, but the error escaped the route as a 500
    // with an empty body, and the player's catch told the student "we could not
    // reach the server". The server was reached, and their paper had started.
    //
    // Catching the violation afterwards would not work either: Postgres aborts
    // the whole transaction on a constraint error, so the recovery read would
    // fail too. `ON CONFLICT DO NOTHING` is the one shape that stays inside the
    // transaction — it waits for the other inserter to commit, then reports
    // that it skipped, and the loser resumes the sitting that won.
    //
    // Same lesson as `uniqueSlug`, which stopped checking first and moved into
    // the insert loop of `app_auth_bootstrap_org`.
    const inserted = await tx.attempt.createMany({
      data: [
        {
          id: attemptId,
          organizationId: actor.organizationId,
          assignmentId,
          studentUserId: actor.userId,
          clientAttemptId,
          attemptNumber: used + 1,
          startedAt: now,
          durationMs: expiresAt.getTime() - now.getTime(),
          expiresAt,
        },
      ],
      skipDuplicates: true,
    });

    if (inserted.count === 0) {
      // The other request won. It has committed by the time we get here — the
      // conflicting insert blocks until it does — so its answer rows exist and
      // this is a resume, not a second sitting.
      const winner = await tx.attempt.findFirst({
        where: { assignmentId, studentUserId: actor.userId, clientAttemptId },
      });
      if (winner) {
        return { ok: true, attemptId: winner.id, resumed: true };
      }
      // Skipped, and yet not there: the only way is a different unique index,
      // which is a bug rather than a race. Refuse rather than press on and
      // create answer rows against an attempt that does not exist.
      return {
        ok: false,
        code: "CONFLICT",
        message: "We could not start that test. Try again.",
      };
    }

    // One answer row per question up front, so the paper's shape is fixed at
    // the moment the student started it. A question added to the assessment
    // later cannot appear mid-sitting.
    const questions = await tx.assessmentQuestion.findMany({
      where: { assessmentId: assignment.assessmentId },
      orderBy: { position: "asc" },
    });

    await tx.attemptAnswer.createMany({
      data: questions.map((question) => ({
        id: randomUUID(),
        organizationId: actor.organizationId,
        attemptId,
        assessmentQuestionId: question.id,
        questionVersionId: question.questionVersionId,
        maxMarks: question.marks,
      })),
    });

    return { ok: true, attemptId, resumed: false };
  });
}

export type PlayerQuestion = {
  assessmentQuestionId: string;
  position: number;
  /**
   * The number printed beside it. Alternatives in an "OR" pair share one, so
   * it is not the position.
   */
  number: number;
  /** "A", "B" … on a sectioned paper. */
  section: string | null;
  /**
   * Shared with its alternative when this is half of an internal choice. The
   * student answers one; answering the other clears the first.
   */
  choiceGroup: number | null;
  marks: number;
  type: QuestionType;
  stem: string;
  /** Choice text only. `isCorrect` is stripped — see the note in getPlayer. */
  options: { key: string; text: string }[] | null;
  response: Response;
  markedForReview: boolean;
  /**
   * The sequence number of the save the server holds for this question.
   *
   * Sent so a reloaded player resumes ABOVE it. It used to restart at 1 on
   * every load, and the server keeps a save only when its sequence is higher
   * than the stored one — so after a refresh every edit to a question already
   * answered was ignored as "older", while the header said Saved.
   */
  clientSeq: number;
  /** Seconds on this question so far, carried across a reload. */
  timeSpentSeconds: number;
  /** Times this question has been opened so far, carried across a reload. */
  visitCount: number;
};

export type PlayerState = {
  attemptId: string;
  status: string;
  title: string;
  serverTime: Date;
  startedAt: Date;
  expiresAt: Date;
  /** Milliseconds left, computed here so the client never has to guess. */
  remainingMs: number;
  totalMarks: number;
  questions: PlayerQuestion[];
};

/**
 * The paper as the student sees it.
 *
 * The one thing this function exists to guarantee: **no answer key leaves
 * here while the attempt is in progress.** Options are rebuilt as `{key, text}`
 * rather than filtered, so a field added to `Option` later cannot leak by
 * being forgotten.
 */
export async function getPlayer(
  actor: StudentActor,
  attemptId: string,
): Promise<PlayerState | null> {
  const now = new Date();

  return withTenant(actor.organizationId, async (tx) => {
    const attempt = await tx.attempt.findFirst({
      where: { id: attemptId, studentUserId: actor.userId },
      include: {
        assignment: {
          include: { assessment: { select: { title: true, totalMarks: true } } },
        },
        answers: true,
      },
    });
    if (!attempt) return null;

    const answerRows = attempt.answers;
    const questionIds = answerRows.map((a) => a.assessmentQuestionId);

    const placements = await tx.assessmentQuestion.findMany({
      where: { id: { in: questionIds } },
      orderBy: { position: "asc" },
      include: {
        question: {
          include: { versions: { orderBy: { version: "desc" } } },
        },
      },
    });

    const answerByQuestion = new Map(
      answerRows.map((answer) => [answer.assessmentQuestionId, answer]),
    );
    const numbers = displayNumbers(placements);
    const numberOf = new Map(placements.map((placement, index) => [placement.id, numbers[index]!]));

    const questions: PlayerQuestion[] = placements.flatMap((placement) => {
      const answer = answerByQuestion.get(placement.id);
      if (!answer) return [];

      // The version the student was SERVED, not the current one.
      const version =
        placement.question.versions.find((v) => v.id === answer.questionVersionId) ??
        placement.question.versions[0];
      if (!version) return [];

      const rawOptions = (version.options as Option[] | null) ?? null;

      return [
        {
          assessmentQuestionId: placement.id,
          position: placement.position,
          number: numberOf.get(placement.id) ?? placement.position,
          section: placement.section,
          choiceGroup: placement.choiceGroup,
          marks: placement.marks,
          type: placement.question.type as QuestionType,
          stem: version.stem,
          // Rebuilt, not filtered: a field added to Option later cannot leak
          // by somebody forgetting to strip it.
          options: rawOptions
            ? rawOptions.map((option) => ({ key: option.key, text: option.text }))
            : null,
          // Normalised on the way out as well as in, for rows saved before
          // blanks were: a `{keys: []}` restored into the player would show a
          // question as answered with nothing ticked.
          response: normaliseResponse((answer.response as Response) ?? null),
          markedForReview: answer.markedForReview,
          clientSeq: answer.clientSeq,
          timeSpentSeconds: answer.timeSpentSeconds,
          visitCount: answer.visitCount,
        },
      ];
    });

    return {
      attemptId: attempt.id,
      status: attempt.status,
      title: attempt.assignment.assessment.title,
      serverTime: now,
      startedAt: attempt.startedAt,
      expiresAt: attempt.expiresAt,
      // Derived, every time. Never accumulated, never cached.
      remainingMs: Math.max(0, attempt.expiresAt.getTime() - now.getTime()),
      totalMarks: attempt.assignment.assessment.totalMarks,
      questions,
    };
  });
}

export type AnswerPatch = {
  assessmentQuestionId: string;
  response: Response;
  markedForReview?: boolean;
  /** The running total for this question, not an increment. */
  timeSpentSeconds?: number;
  /**
   * The running count of times the question was opened, not an increment.
   *
   * A total, because a total is idempotent under last-write-wins and an
   * increment is not: it used to go up by one per SAVE, so a student who typed
   * a long answer in one visit looked like somebody who kept coming back — and
   * the CARELESS rule reads exactly this number.
   */
  visitCount?: number;
  clientSeq: number;
};

export type SaveResult = {
  saved: number;
  ignored: number;
  serverTime: Date;
  remainingMs: number;
  expired: boolean;
};

/**
 * Save a batch of answers.
 *
 * Idempotent per question by `clientSeq`: a batch that arrives late after a
 * reconnect is ignored rather than overwriting a newer answer with an older
 * one. Nothing here throws on a stale batch — a student mid-exam is never
 * blocked and never loses work, so "already have something newer" is a normal
 * outcome, not an error.
 */
export async function saveAnswers(
  actor: StudentActor,
  attemptId: string,
  patches: AnswerPatch[],
): Promise<SaveResult | null> {
  const now = new Date();

  return withTenant(actor.organizationId, async (tx) => {
    const attempt = await tx.attempt.findFirst({
      where: { id: attemptId, studentUserId: actor.userId },
    });
    if (!attempt) return null;

    const remainingMs = Math.max(0, attempt.expiresAt.getTime() - now.getTime());
    const expired = now >= attempt.expiresAt;

    if (attempt.status !== "IN_PROGRESS") {
      // Already submitted. Accept the request without writing, so a client
      // flushing its queue after a submit does not see an error it cannot act
      // on.
      return { saved: 0, ignored: patches.length, serverTime: now, remainingMs, expired };
    }

    let saved = 0;
    let ignored = 0;

    for (const patch of patches) {
      const result = await tx.attemptAnswer.updateMany({
        where: {
          attemptId,
          assessmentQuestionId: patch.assessmentQuestionId,
          // The whole ordering guarantee, in one clause.
          clientSeq: { lt: patch.clientSeq },
        },
        data: {
          // Blank is stored as null — see core/attempts/response.ts. A cleared
          // selection saved as `{keys: []}` was read back as an answer
          // awaiting marking.
          response: normaliseResponse(patch.response ?? null) as Prisma.InputJsonValue,
          markedForReview: patch.markedForReview ?? false,
          clientSeq: patch.clientSeq,
          answeredAt: now,
          ...(patch.timeSpentSeconds !== undefined
            ? { timeSpentSeconds: patch.timeSpentSeconds }
            : {}),
          ...(patch.visitCount !== undefined ? { visitCount: patch.visitCount } : {}),
        },
      });
      if (result.count > 0) saved++;
      else ignored++;
    }

    return { saved, ignored, serverTime: now, remainingMs, expired };
  });
}

export type SubmitResult =
  | {
      ok: true;
      alreadySubmitted: boolean;
      rawScore: number;
      maxScore: number;
      percentage: number;
      provisional: boolean;
      showResult: boolean;
    }
  | { ok: false; code: "NOT_FOUND"; message: string };

/**
 * Submit.
 *
 * ARCHITECTURE.md section 7 in order, and nothing else on this path. Every
 * interpretive step — mastery, gaps, recommendations, the prose a teacher
 * reads — happens later, off an outbox row. If the AI provider is on fire, a
 * student still gets their score.
 */
export async function submitAttempt(
  actor: StudentActor,
  attemptId: string,
  reason: "MANUAL" | "TIMEOUT" = "MANUAL",
): Promise<SubmitResult> {
  const now = new Date();

  const outcome = await withTenant<SubmitResult>(
    actor.organizationId,
    async (tx) => {
      const attempt = await tx.attempt.findFirst({
        where: { id: attemptId, studentUserId: actor.userId },
        include: {
          assignment: { select: { resultsPolicy: true, closesAt: true } },
          answers: true,
        },
      });
      if (!attempt) {
        return { ok: false, code: "NOT_FOUND", message: "We could not find that attempt." };
      }

      const policy = attempt.assignment.resultsPolicy;
      const showResult =
        policy === "IMMEDIATE" ||
        (policy === "AFTER_CLOSE" && now >= attempt.assignment.closesAt);

      // Idempotent: a retry returns the first result, with 200. The client
      // that retried did nothing wrong.
      if (attempt.status !== "IN_PROGRESS") {
        return {
          ok: true,
          alreadySubmitted: true,
          rawScore: Number(attempt.rawScore ?? 0),
          maxScore: Number(attempt.maxScore ?? 0),
          percentage: Number(attempt.percentage ?? 0),
          // `response !== null` is the half that was missing, and it matters on
          // exactly this path.
          //
          // A blank objective answer has no marks AND no response. It is
          // SETTLED at zero and nobody will ever mark it — the rule is stated
          // in CLAUDE.md and implemented correctly everywhere else
          // (`analytics/student.ts`, `student-view.ts`, `itemstats/index.ts`
          // all carry both halves). Without the second half, a student who
          // skipped one MCQ was told their result was provisional with marks
          // still to come that were never coming.
          //
          // And this is the re-submit branch, so it only fired on a retry —
          // a double tap on flaky school wifi, which is the exact case the
          // idempotent path exists to serve. The student who did nothing wrong
          // is the one who got the wrong answer.
          provisional: attempt.answers.some(
            (a) => a.awardedMarks === null && !isBlankResponse(a.response),
          ),
          showResult,
        };
      }

      const placements = await tx.assessmentQuestion.findMany({
        where: { id: { in: attempt.answers.map((a) => a.assessmentQuestionId) } },
        include: {
          question: { include: { versions: { orderBy: { version: "desc" } } } },
        },
      });
      const placementById = new Map(placements.map((p) => [p.id, p]));

      // An internal choice: the alternative the student did not take is
      // removed before anything is marked. Scored as a blank it would be a
      // zero in their total, a mistake in their bank and evidence against a
      // concept they were never asked about. See core/assessments/pattern.ts.
      const dropPositions = new Set(
        alternativesToDrop(
          attempt.answers.flatMap((answer) => {
            const placement = placementById.get(answer.assessmentQuestionId);
            return placement
              ? [
                  {
                    position: placement.position,
                    choiceGroup: placement.choiceGroup,
                    answered: !isBlankResponse(answer.response),
                  },
                ]
              : [];
          }),
        ),
      );
      const dropped = attempt.answers.filter((answer) => {
        const placement = placementById.get(answer.assessmentQuestionId);
        return placement !== undefined && dropPositions.has(placement.position);
      });
      if (dropped.length > 0) {
        await tx.attemptAnswer.deleteMany({
          where: { id: { in: dropped.map((answer) => answer.id) } },
        });
      }
      const droppedIds = new Set(dropped.map((answer) => answer.id));

      const marks = [];

      for (const answer of attempt.answers) {
        if (droppedIds.has(answer.id)) continue;
        const placement = placementById.get(answer.assessmentQuestionId);
        if (!placement) continue;

        // The version SERVED, so an edit after the sitting cannot change what
        // this answer was marked against.
        const version =
          placement.question.versions.find((v) => v.id === answer.questionVersionId) ??
          placement.question.versions[0];

        const marked = markAnswer({
          type: placement.question.type as QuestionType,
          maxMarks: Number(answer.maxMarks),
          options: (version?.options as Option[] | null) ?? null,
          answerKey: (version?.answerKey as AnswerKey) ?? null,
          response: (answer.response as Response) ?? null,
        });

        marks.push(marked);

        await tx.attemptAnswer.update({
          where: { id: answer.id },
          data: {
            isCorrect: marked.isCorrect,
            awardedMarks: marked.awardedMarks,
            gradeSource: marked.awardedMarks === null ? null : "AUTO",
            gradedAt: marked.awardedMarks === null ? null : now,
          },
        });
      }

      const summary = summarise(marks);

      await tx.attempt.update({
        where: { id: attemptId },
        data: {
          status: "SCORED",
          submittedAt: now,
          submitReason: reason,
          scoredAt: now,
          rawScore: summary.rawScore,
          maxScore: summary.maxScore,
          percentage: summary.percentage,
        },
      });

      return {
        ok: true,
        alreadySubmitted: false,
        rawScore: summary.rawScore,
        maxScore: summary.maxScore,
        percentage: summary.percentage,
        provisional: summary.provisional,
        showResult,
      };
    },
  );

  if (outcome.ok && !outcome.alreadySubmitted) {
    // After the transaction, deliberately. The paper is committed and marked
    // before the ledger is touched, so nothing about mastery bookkeeping can
    // cost a student their submission. See core/mastery/sync.
    await syncAttemptMastery(actor.organizationId, attemptId, now);
    // Gaps read mastery, so they follow it. Both are after the transaction and
    // neither can cost a student their submission.
    await syncGapsForAttempt(actor.organizationId, attemptId, now);
    // And the student's own bank. Last, and after the ledger: resolution reads
    // the evidence this same submission just wrote, so a student who finally
    // gets a concept right sees the old mistake close on the same submit.
    await recordAttemptMistakes(actor.organizationId, attemptId, now);
    await reconcileResolved(actor.organizationId, actor.userId, now);

    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: "STUDENT",
      action: "attempt.submitted",
      entityType: "attempt",
      entityId: attemptId,
      after: { reason, score: outcome.rawScore, of: outcome.maxScore },
    });
  }

  return outcome;
}

/**
 * Finish attempts whose clock ran out while the page was closed.
 *
 * Without this, a student who shuts their laptop mid-test leaves a row that is
 * IN_PROGRESS forever, and their work is never marked. Runs from cron; touches
 * only attempts nobody is still sitting.
 */
export async function sweepExpiredAttempts(
  organizationId: string,
  now = new Date(),
): Promise<number> {
  const stale = await withTenant(organizationId, (tx) =>
    tx.attempt.findMany({
      where: { status: "IN_PROGRESS", expiresAt: { lt: now } },
      select: { id: true, studentUserId: true },
    }),
  );

  let swept = 0;
  for (const attempt of stale) {
    const result = await submitAttempt(
      { organizationId, userId: attempt.studentUserId },
      attempt.id,
      "TIMEOUT",
    );
    if (result.ok) {
      await withTenant(organizationId, (tx) =>
        tx.attempt.updateMany({
          where: { id: attempt.id },
          data: { submitReason: "SWEEP" },
        }),
      );
      swept++;
    }
  }

  return swept;
}

export { markAnswer, summarise };
