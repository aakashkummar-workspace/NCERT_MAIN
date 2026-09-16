import "server-only";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { isObjective, type QuestionType } from "@/core/questions/validate";
import { syncAttemptMastery } from "@/core/mastery/sync";
import { recordAttemptMistakes } from "@/core/mistakes/record";
import { reconcileResolved } from "@/core/mistakes/read";
import { syncGapsForAttempt } from "@/core/gaps/sync";
import { rescoreAttempt } from "./rescore";
import {
  parseRubric,
  totalFor,
  validateScores,
  type CriterionScore,
  type Rubric,
} from "@/core/questions/rubric";

/**
 * Marking what the machine cannot.
 *
 * Objective questions were marked at submission. Everything written — VSA, SA,
 * LA, case studies — sits at `awardedMarks: null` until a person reads it, and
 * the student's result page says so in as many words. This module is the other
 * end of that promise.
 *
 * ---------------------------------------------------------------------------
 * The queue is ordered by QUESTION, not by student
 * ---------------------------------------------------------------------------
 * Twenty-four answers to the same question, one after another, is both faster
 * and fairer than twenty-four whole papers: the marker holds one mark scheme in
 * their head, and the fourth answer is judged by the same standard as the
 * twentieth. Paper-by-paper marking is where a tired teacher marks the last six
 * students harder than the first six, and neither they nor the student ever
 * finds out.
 *
 * It also means the marker is not reading names. That is deliberate.
 */

export type Actor = { organizationId: string; userId: string; role: string };

export type MarkableAnswer = {
  answerId: string;
  attemptId: string;
  /** Shown only after marking, so the mark is given to the answer. */
  studentName: string;
  response: string;
  marks: number;
  awardedMarks: number | null;
  feedback: string | null;
  gradeSource: string | null;
  /** What was awarded per criterion, once marked against a scheme. */
  rubricScores: CriterionScore[] | null;
};

export type MarkingGroup = {
  assessmentQuestionId: string;
  position: number;
  type: string;
  stem: string;
  marks: number;
  /** The mark scheme, for the person marking — never sent to a student here. */
  expectedAnswer: string | null;
  explanation: string | null;
  /**
   * The written mark scheme, when the question has one.
   *
   * Null is an ordinary state: a rubric improves on typing a number, it does
   * not replace it, and every question authored before this existed has none.
   */
  rubric: Rubric | null;
  answers: MarkableAnswer[];
  unmarked: number;
};

export type MarkingQueue = {
  assignmentId: string;
  title: string;
  className: string;
  groups: MarkingGroup[];
  totalUnmarked: number;
};

/**
 * Everything on this assignment that needs a person, grouped by question.
 *
 * Includes answers already marked, so a teacher can change their mind — a mark
 * scheme that turns out to be wrong on question 4 is discovered at answer
 * eleven, and going back is the normal case, not an exception.
 */
export async function markingQueue(
  actor: Actor,
  assignmentId: string,
): Promise<MarkingQueue | null> {
  return withTenant<MarkingQueue | null>(actor.organizationId, async (tx) => {
    const assignment = await tx.assignment.findFirst({
      where: { id: assignmentId },
      include: {
        assessment: { select: { title: true } },
        class: { select: { name: true } },
      },
    });
    if (!assignment) return null;

    // Only sittings that are over. A paper still being written is not ready to
    // be marked, and showing a half-finished answer to a marker invites a mark
    // on work the student had not finished making.
    const attempts = await tx.attempt.findMany({
      where: { assignmentId, status: { not: "IN_PROGRESS" } },
      include: { answers: true },
      // Stable, and stable is the point. Without an explicit order Postgres is
      // free to return these differently on the next read, so the list
      // reshuffles under a marker every time a mark is saved and "Answer 3"
      // becomes a different student's answer between two clicks.
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    });
    if (attempts.length === 0) {
      return {
        assignmentId,
        title: assignment.assessment.title,
        className: assignment.class.name,
        groups: [],
        totalUnmarked: 0,
      };
    }

    const studentIds = [...new Set(attempts.map((a) => a.studentUserId))];
    const students = await tx.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, fullName: true },
    });
    const nameById = new Map(students.map((s) => [s.id, s.fullName]));

    const placements = await tx.assessmentQuestion.findMany({
      where: { assessmentId: assignment.assessmentId },
      orderBy: { position: "asc" },
      include: {
        question: { include: { versions: { orderBy: { version: "desc" } } } },
      },
    });

    const groups: MarkingGroup[] = [];

    for (const placement of placements) {
      const type = placement.question.type as QuestionType;
      // Objective questions were settled by the marker at submission. Putting
      // them in a human queue would be asking a teacher to re-do arithmetic.
      if (isObjective(type)) continue;

      const answers: MarkableAnswer[] = [];

      for (const attempt of attempts) {
        const answer = attempt.answers.find(
          (a) => a.assessmentQuestionId === placement.id,
        );
        if (!answer) continue;

        // Nothing written is nothing to mark. It is already settled at
        // unanswered, and putting it in the queue would have a teacher award
        // marks for a blank page.
        const response = answer.response as { kind?: string; value?: unknown } | null;
        if (response === null) continue;
        const text =
          response.kind === "text" ? String(response.value ?? "") : JSON.stringify(response);
        if (text.trim().length === 0) continue;

        answers.push({
          answerId: answer.id,
          attemptId: attempt.id,
          studentName: nameById.get(attempt.studentUserId) ?? "Unknown",
          response: text,
          marks: Number(answer.maxMarks),
          awardedMarks:
            answer.awardedMarks === null ? null : Number(answer.awardedMarks),
          feedback: answer.feedback,
          gradeSource: answer.gradeSource,
          rubricScores: parseScores(answer.rubricScores),
        });
      }

      if (answers.length === 0) continue;

      // The version FROZEN at publish, not the newest. A teacher who edited
      // the question in December must be marking against what the class
      // actually sat in August.
      const version =
        placement.question.versions.find((v) => v.id === placement.questionVersionId) ??
        placement.question.versions[0];

      const key = version?.answerKey as { accepted?: string[] } | null;

      groups.push({
        assessmentQuestionId: placement.id,
        position: placement.position,
        type,
        stem: version?.stem ?? "",
        marks: placement.marks,
        expectedAnswer: key?.accepted?.join(" / ") ?? null,
        explanation: version?.explanation ?? null,
        rubric: parseRubric(version?.rubric),
        answers,
        unmarked: answers.filter((a) => a.awardedMarks === null).length,
      });
    }

    return {
      assignmentId,
      title: assignment.assessment.title,
      className: assignment.class.name,
      groups,
      totalUnmarked: groups.reduce((sum, group) => sum + group.unmarked, 0),
    };
  });
}

export type AwardResult =
  | { ok: true; rawScore: number; maxScore: number; percentage: number; pendingMarks: number }
  | { ok: false; message: string };

/**
 * Award marks to one written answer.
 *
 * Refuses a mark outside the question's range rather than clamping it. A
 * teacher typing 30 into a 3-mark box has made a mistake, and silently storing
 * 3 hides it — from them now and from the student's total forever.
 */
export async function awardMarks(
  actor: Actor,
  answerId: string,
  awardedMarks: number,
  feedback?: string | null,
): Promise<AwardResult> {
  const now = new Date();

  const outcome = await withTenant<
    AwardResult & { attemptId?: string; studentUserId?: string }
  >(
    actor.organizationId,
    async (tx) => {
      const answer = await tx.attemptAnswer.findFirst({ where: { id: answerId } });
      if (!answer) {
        return { ok: false, message: "We could not find that answer." };
      }

      const max = Number(answer.maxMarks);
      if (!Number.isFinite(awardedMarks) || awardedMarks < 0 || awardedMarks > max) {
        return {
          ok: false,
          message: `Give a mark between 0 and ${max}.`,
        };
      }

      const attempt = await tx.attempt.findFirst({
        where: { id: answer.attemptId },
        select: { status: true, studentUserId: true },
      });
      if (!attempt || attempt.status === "IN_PROGRESS") {
        return {
          ok: false,
          message: "That paper has not been submitted yet.",
        };
      }

      await tx.attemptAnswer.update({
        where: { id: answerId },
        data: {
          awardedMarks,
          // Full marks is correct, none is not, and everything between is
          // neither — a 2 out of 3 recorded as `false` would tell the analytics
          // the student got it wrong.
          isCorrect: awardedMarks >= max ? true : awardedMarks <= 0 ? false : null,
          gradeSource: "TEACHER",
          gradedAt: now,
          feedback: feedback?.trim() ? feedback.trim().slice(0, 2000) : null,
        },
      });

      const summary = await rescoreAttempt(tx, answer.attemptId, now);

      return {
        ok: true,
        attemptId: answer.attemptId,
        studentUserId: attempt.studentUserId,
        rawScore: summary.rawScore,
        maxScore: summary.maxScore,
        percentage: summary.percentage,
        pendingMarks: summary.pendingMarks,
      };
    },
  );

  if (outcome.ok && outcome.attemptId) {
    // A written answer becomes evidence the moment a person marks it — dated
    // to the day the student sat the paper, not to today.
    await syncAttemptMastery(actor.organizationId, outcome.attemptId, now);
    await syncGapsForAttempt(actor.organizationId, outcome.attemptId, now);
    // A written answer is not a mistake until somebody has read it, so this is
    // the moment it becomes one — or stops being one, if the teacher has just
    // raised it to full marks.
    await recordAttemptMistakes(actor.organizationId, outcome.attemptId, now);
    if (outcome.studentUserId) {
      await reconcileResolved(actor.organizationId, outcome.studentUserId, now);
    }
  }

  if (outcome.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "answer.marked",
      entityType: "attempt_answer",
      entityId: answerId,
      after: { awardedMarks, attemptId: outcome.attemptId },
    });
  }

  return outcome;
}

/**
 * Mark against the question's own mark scheme.
 *
 * ---------------------------------------------------------------------------
 * The total is derived, never typed
 * ---------------------------------------------------------------------------
 * A marker who fills in the criteria AND a total can disagree with themselves,
 * and whichever the product stores, the student is shown a breakdown that does
 * not add up to their mark. So this takes only the per-criterion marks and
 * computes the total — there is no parameter for it, which is the reason it
 * cannot drift.
 *
 * It shares every downstream rule with `awardMarks`: the same partial-credit
 * handling, the same re-score, the same evidence and mistake-bank hooks. What
 * it adds is the breakdown the student sees, which is the whole point — "method
 * 2 of 3, working 1 of 2, answer 0 of 1" tells them where it went, and "3 out
 * of 6" tells them only that it did.
 */
export async function awardByRubric(
  actor: Actor,
  answerId: string,
  scores: CriterionScore[],
  feedback?: string | null,
): Promise<AwardResult> {
  const prepared = await withTenant<
    | { ok: false; message: string }
    | { ok: true; total: number; max: number; attemptId: string }
  >(actor.organizationId, async (tx) => {
    const answer = await tx.attemptAnswer.findFirst({ where: { id: answerId } });
    if (!answer) return { ok: false, message: "We could not find that answer." };

    const version = answer.questionVersionId
      ? await tx.questionVersion.findFirst({
          where: { id: answer.questionVersionId },
          select: { rubric: true },
        })
      : null;

    const rubric = parseRubric(version?.rubric);
    if (!rubric) {
      // No scheme to mark against. Told plainly rather than silently falling
      // back to a total, which would store a breakdown against criteria that
      // do not exist.
      return {
        ok: false,
        message:
          "This question has no mark scheme. Give it a total instead, or add a scheme to the question first.",
      };
    }

    const problems = validateScores(rubric, scores);
    if (problems.length > 0) {
      return { ok: false, message: problems[0]!.message };
    }

    const attempt = await tx.attempt.findFirst({
      where: { id: answer.attemptId },
      select: { status: true },
    });
    if (!attempt || attempt.status === "IN_PROGRESS") {
      return { ok: false, message: "That paper has not been submitted yet." };
    }

    return {
      ok: true,
      total: totalFor(scores),
      max: Number(answer.maxMarks),
      attemptId: answer.attemptId,
    };
  });

  if (!prepared.ok) return prepared;

  // The breakdown is stored alongside, then everything else goes through the
  // one function that already knows how to mark. A second copy of the
  // partial-credit rule, the re-score and the four downstream hooks is a second
  // copy that drifts.
  await withTenant(actor.organizationId, (tx) =>
    tx.attemptAnswer.update({
      where: { id: answerId },
      data: {
        rubricScores: scores.map((score) => ({
          criterionId: score.criterionId,
          marks: score.marks,
          note: score.note?.trim() ? score.note.trim().slice(0, 500) : null,
        })) as never,
      },
    }),
  );

  return awardMarks(actor, answerId, prepared.total, feedback);
}

/** The stored breakdown for one answer, or null. */
export function parseScores(value: unknown): CriterionScore[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const scores: CriterionScore[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.criterionId !== "string") return null;
    if (typeof row.marks !== "number" || !Number.isFinite(row.marks)) return null;
    scores.push({
      criterionId: row.criterionId,
      marks: row.marks,
      note: typeof row.note === "string" ? row.note : null,
    });
  }
  return scores;
}
