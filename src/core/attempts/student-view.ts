import "server-only";
import { withTenant } from "@/db/tenant";
import {
  assignmentStatus,
  describeWindow,
  resultsVisible,
} from "@/core/assignments/window";
import type { Response } from "./score";
import { isBlankResponse } from "./response";
import { parseRubric } from "@/core/questions/rubric";
import { parseScores } from "@/core/results/marking";

/**
 * What a student sees on their home screen: the tests they can take, and when.
 *
 * Deliberately not "all assignments in the organization filtered client-side" —
 * the query starts from what this student is enrolled in and targeted for, so
 * a bug in a filter cannot show them somebody else's paper.
 */

export type StudentAssignment = {
  assignmentId: string;
  title: string;
  className: string;
  subjectName: string;
  questionCount: number;
  totalMarks: number;
  durationMinutes: number;
  opensAt: Date;
  closesAt: Date;
  status: "SCHEDULED" | "OPEN" | "CLOSED" | "CANCELLED";
  window: string;
  attemptsUsed: number;
  maxAttempts: number;
  /** The sitting to resume, if one is unfinished. */
  inProgressAttemptId: string | null;
  /** A finished sitting, when the teacher has allowed them to see it. */
  finishedAttemptId: string | null;
  canStart: boolean;
  /** Sat on paper in the room; never started here. */
  onPaper: boolean;
  resultVisible: boolean;
};

export async function studentAssignments(
  organizationId: string,
  studentUserId: string,
): Promise<StudentAssignment[]> {
  const now = new Date();

  return withTenant(organizationId, async (tx) => {
    const enrolments = await tx.classEnrolment.findMany({
      where: { studentUserId, status: "ACTIVE" },
      select: { classId: true },
    });
    const classIds = enrolments.map((e) => e.classId);
    if (classIds.length === 0) return [];

    const assignments = await tx.assignment.findMany({
      where: { classId: { in: classIds }, cancelledAt: null },
      include: {
        assessment: {
          select: {
            title: true,
            totalMarks: true,
            durationMinutes: true,
            subject: { select: { name: true } },
            _count: { select: { questions: true } },
          },
        },
        class: { select: { name: true } },
        targets: { select: { studentUserId: true } },
        attempts: {
          where: { studentUserId },
          orderBy: { attemptNumber: "desc" },
        },
      },
      orderBy: { closesAt: "asc" },
    });

    return assignments
      // No target rows means the whole class.
      .filter(
        (assignment) =>
          assignment.targets.length === 0 ||
          assignment.targets.some((t) => t.studentUserId === studentUserId),
      )
      .map((assignment) => {
        const status = assignmentStatus(assignment, now);
        const inProgress = assignment.attempts.find(
          (attempt) => attempt.status === "IN_PROGRESS",
        );
        const finished = assignment.attempts.find(
          (attempt) => attempt.status !== "IN_PROGRESS",
        );

        const resultVisible =
          Boolean(finished) && resultsVisible(assignment, now);

        return {
          assignmentId: assignment.id,
          title: assignment.assessment.title,
          className: assignment.class.name,
          subjectName: assignment.assessment.subject.name,
          questionCount: assignment.assessment._count.questions,
          totalMarks: assignment.assessment.totalMarks,
          durationMinutes:
            assignment.durationOverrideMinutes ??
            assignment.assessment.durationMinutes,
          opensAt: assignment.opensAt,
          closesAt: assignment.closesAt,
          status,
          window: describeWindow(assignment, now),
          attemptsUsed: assignment.attempts.length,
          maxAttempts: assignment.maxAttempts,
          inProgressAttemptId: inProgress?.id ?? null,
          finishedAttemptId: finished?.id ?? null,
          canStart:
            assignment.deliveryMode !== "PAPER" &&
            status === "OPEN" &&
            (Boolean(inProgress) ||
              assignment.attempts.length < assignment.maxAttempts),
          onPaper: assignment.deliveryMode === "PAPER",
          resultVisible,
        };
      });
  });
}

export type StudentResult = {
  attemptId: string;
  title: string;
  submittedAt: Date | null;
  rawScore: number;
  maxScore: number;
  percentage: number;
  provisional: boolean;
  /**
   * Marks on questions a person still has to mark.
   *
   * Deliberately NOT "every unscored mark". A written answer waiting on a
   * teacher may still earn its marks; an objective question left blank never
   * will. Counting the blank one as pending promises the student a score that
   * is never coming, and counting the written one as zero takes marks off them
   * that they may well have earned.
   */
  pendingMarks: number;
  /** Null until the teacher's policy allows it — never a fabricated score. */
  visible: boolean;
  /**
   * Whether the answer key travels with the result.
   *
   * A stronger gate than `visible`, and deliberately so. Under IMMEDIATE a
   * student sees their score the moment they submit — which is the point of
   * that policy — but a class sitting the same paper in two sessions would
   * then have the first session holding the key while the second is still
   * writing. So the key waits for the window to close, or for the teacher to
   * release results by hand.
   */
  reviewable: boolean;
  breakdown: {
    position: number;
    stem: string;
    marks: number;
    awardedMarks: number | null;
    isCorrect: boolean | null;
    /** False means they left it blank — which is not the same as unmarked. */
    answered: boolean;
    /** Everything below is present only when `reviewable`. */
    type: string | null;
    response: Response | null;
    options: { key: string; text: string; isCorrect: boolean }[] | null;
    correctAnswer: string | null;
    explanation: string | null;
    /** What the marker wrote, on a question a person marked. */
    feedback: string | null;
    /**
     * Where the marks went, when the question had a mark scheme.
     *
     * The reason this feature exists: "method 2 of 2, working 0.5 of 1" tells a
     * student what to fix, and "2.5 out of 3" tells them only that there is
     * something. Gated on `reviewable` with everything else — a breakdown is a
     * stronger disclosure than a total, and a class sitting in two sessions
     * must not have the first one holding the mark scheme.
     */
    breakdown: { label: string; marks: number; outOf: number; note: string | null }[] | null;
  }[];
};

/**
 * A finished sitting, as the student may see it.
 *
 * When the policy says not yet, `visible` is false and the numbers are not
 * sent at all — a score that must not be displayed is a score that should not
 * be transmitted.
 */
export async function studentResult(
  organizationId: string,
  studentUserId: string,
  attemptId: string,
): Promise<StudentResult | null> {
  const now = new Date();

  return withTenant(organizationId, async (tx) => {
    const attempt = await tx.attempt.findFirst({
      where: { id: attemptId, studentUserId },
      include: {
        assignment: {
          include: { assessment: { select: { title: true } } },
        },
        answers: true,
      },
    });
    if (!attempt) return null;

    const visible =
      attempt.status !== "IN_PROGRESS" &&
      resultsVisible(attempt.assignment, now);

    if (!visible) {
      return {
        attemptId: attempt.id,
        title: attempt.assignment.assessment.title,
        submittedAt: attempt.submittedAt,
        rawScore: 0,
        maxScore: 0,
        percentage: 0,
        provisional: false,
        pendingMarks: 0,
        visible: false,
        reviewable: false,
        breakdown: [],
      };
    }

    // See the note on `reviewable`. The score can be shown the moment a paper
    // is submitted; the key waits until nobody is still sitting the paper.
    const reviewable =
      now >= attempt.assignment.closesAt ||
      attempt.assignment.resultsReleasedAt !== null;

    const placements = await tx.assessmentQuestion.findMany({
      where: { id: { in: attempt.answers.map((a) => a.assessmentQuestionId) } },
      orderBy: { position: "asc" },
      include: {
        question: { include: { versions: { orderBy: { version: "desc" } } } },
      },
    });
    const answerByQuestion = new Map(
      attempt.answers.map((a) => [a.assessmentQuestionId, a]),
    );

    const pending = placements.reduce((total, placement) => {
      const answer = answerByQuestion.get(placement.id);
      const awaiting =
        answer !== undefined &&
        answer.awardedMarks === null &&
        // Blank is settled, not pending. `!== null` alone counted a cleared
        // selection saved as `{keys: []}` as marks still to come.
        !isBlankResponse(answer.response);
      return awaiting ? total + placement.marks : total;
    }, 0);

    return {
      attemptId: attempt.id,
      title: attempt.assignment.assessment.title,
      submittedAt: attempt.submittedAt,
      rawScore: Number(attempt.rawScore ?? 0),
      maxScore: Number(attempt.maxScore ?? 0),
      percentage: Number(attempt.percentage ?? 0),
      provisional: attempt.answers.some(
        (a) => a.awardedMarks === null && !isBlankResponse(a.response),
      ),
      pendingMarks: pending,
      visible: true,
      reviewable,
      breakdown: placements.flatMap((placement) => {
        const answer = answerByQuestion.get(placement.id);
        if (!answer) return [];
        const version =
          placement.question.versions.find(
            (v) => v.id === answer.questionVersionId,
          ) ?? placement.question.versions[0];
        return [
          {
            position: placement.position,
            stem: version?.stem ?? "",
            marks: placement.marks,
            awardedMarks:
              answer.awardedMarks === null ? null : Number(answer.awardedMarks),
            isCorrect: answer.isCorrect,
            answered: !isBlankResponse(answer.response),
            // Built by naming each field, never by spreading the version row.
            // A column added to QuestionVersion later cannot leak into a
            // student payload by being forgotten — the same rule getPlayer
            // follows for options.
            type: reviewable ? placement.question.type : null,
            response: reviewable ? ((answer.response as Response) ?? null) : null,
            options: reviewable
              ? (((version?.options as RawOption[] | null) ?? null)?.map(
                  (option) => ({
                    key: option.key,
                    text: option.text,
                    isCorrect: option.isCorrect === true,
                  }),
                ) ?? null)
              : null,
            correctAnswer: reviewable ? describeKey(version?.answerKey) : null,
            explanation: reviewable ? (version?.explanation ?? null) : null,
            feedback: reviewable ? answer.feedback : null,
            breakdown: reviewable
              ? buildBreakdown(version?.rubric, answer.rubricScores)
              : null,
          },
        ];
      }),
    };
  });
}

type RawOption = { key: string; text: string; isCorrect?: boolean };

/**
 * The correct answer, in words, for the types that do not carry options.
 *
 * Returns null for the subjective types — they have no key, and printing
 * "no correct answer" beside a three-mark essay would be worse than printing
 * nothing at all.
 */
function describeKey(key: unknown): string | null {
  if (!key || typeof key !== "object") return null;
  const shape = key as {
    kind?: string;
    correct?: boolean;
    value?: number;
    unit?: string;
    accepted?: string[];
    correctKeys?: string[];
  };

  switch (shape.kind) {
    case "boolean":
      return shape.correct ? "True" : "False";
    case "numeric":
      return shape.unit ? `${shape.value} ${shape.unit}` : String(shape.value);
    case "text":
      return shape.accepted?.length ? shape.accepted.join(" / ") : null;
    case "choice":
      return shape.correctKeys?.length ? shape.correctKeys.join(", ") : null;
    default:
      return null;
  }
}

/**
 * Join the stored marks back to the criteria they were given against.
 *
 * Both sides come out of JSON columns, so both are `unknown` and every field is
 * checked. A criterion the marker scored that is no longer on the scheme is
 * dropped rather than shown with a blank label — that can only happen if the
 * question was edited into a new version after marking, and a row reading
 * "undefined: 2 of 0" teaches a student nothing.
 */
function buildBreakdown(
  rubric: unknown,
  scores: unknown,
): { label: string; marks: number; outOf: number; note: string | null }[] | null {
  const parsed = parseRubric(rubric);
  const awarded = parseScores(scores);
  if (!parsed || !awarded) return null;

  const rows: { label: string; marks: number; outOf: number; note: string | null }[] = [];
  for (const criterion of parsed.criteria) {
    const score = awarded.find((row) => row.criterionId === criterion.id);
    if (!score) continue;
    rows.push({
      label: criterion.label,
      marks: score.marks,
      outOf: criterion.marks,
      note: score.note ?? null,
    });
  }
  return rows.length > 0 ? rows : null;
}
