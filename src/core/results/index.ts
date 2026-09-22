import "server-only";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { expectedStudentIds } from "@/core/assignments/cohort";
import { hasOptions, type QuestionType } from "@/core/questions/validate";

/**
 * What a class did with a paper.
 *
 * ---------------------------------------------------------------------------
 * The rule that shapes this whole module
 * ---------------------------------------------------------------------------
 * **A statistic computed over half-marked papers is not a smaller statistic —
 * it is a wrong one.** An average that silently counts an unmarked three-mark
 * answer as nought drags the class mean down and tells a teacher their class
 * struggled with a question nobody has read yet.
 *
 * So every cohort figure here is computed over **fully marked attempts only**,
 * and the count of papers left out is returned beside it. A teacher can then
 * see "mean 62% across 18 of 24 papers" and know exactly what they are looking
 * at, which is the one thing an average over everything cannot tell them.
 *
 * And below MIN_TO_SUMMARISE marked papers there are no figures at all — the
 * same refusal the mastery scale makes below its evidence threshold. A median
 * over one paper is not a median, and four cards reading "0%" because the only
 * marked paper happened to score nothing tells a teacher their class failed
 * when in truth nobody has marked it yet. The refusal lives here rather than in
 * the page, so a number that must not be shown never reaches a component.
 */

/**
 * Fewer marked papers than this and no distribution is reported.
 *
 * Three is not a statistical threshold — it is the point below which the
 * numbers say more about which papers happened to be marked first than about
 * the class.
 */
export const MIN_TO_SUMMARISE = 3;

export type Actor = { organizationId: string; userId: string; role: string };

export type StudentRow = {
  studentUserId: string;
  fullName: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "EXPIRED";
  attemptId: string | null;
  rawScore: number | null;
  maxScore: number | null;
  percentage: number | null;
  submittedAt: Date | null;
  /** Marks on this paper still waiting on a person. */
  pendingMarks: number;
  /** Whether this paper counts towards the cohort figures. */
  fullyMarked: boolean;
};

export type AssignmentResults = {
  assignmentId: string;
  title: string;
  className: string;
  totalMarks: number;
  resultsPolicy: string;
  resultsReleasedAt: Date | null;
  expected: number;
  notStarted: number;
  inProgress: number;
  submitted: number;
  /** Papers with marking outstanding — excluded from every figure below. */
  awaitingMarking: number;
  counted: number;
  /** False when `counted` is below the threshold — every figure is then null. */
  enoughToSummarise: boolean;
  mean: number | null;
  median: number | null;
  highest: number | null;
  lowest: number | null;
  rows: StudentRow[];
};

export async function assignmentResults(
  organizationId: string,
  assignmentId: string,
): Promise<AssignmentResults | null> {
  return withTenant<AssignmentResults | null>(organizationId, async (tx) => {
    const assignment = await tx.assignment.findFirst({
      where: { id: assignmentId },
      include: {
        assessment: { select: { title: true, totalMarks: true } },
        class: { select: { name: true } },
        targets: { select: { studentUserId: true } },
      },
    });
    if (!assignment) return null;

    const studentIds = await expectedStudentIds(tx, assignment);
    const students = await tx.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
    });

    const attempts = await tx.attempt.findMany({
      where: { assignmentId },
      include: { answers: { select: { awardedMarks: true, maxMarks: true, response: true } } },
      orderBy: { attemptNumber: "desc" },
    });

    // The latest sitting per student. A second attempt supersedes the first on
    // this screen; both remain on the record.
    const latest = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      if (!latest.has(attempt.studentUserId)) latest.set(attempt.studentUserId, attempt);
    }

    const rows: StudentRow[] = students.map((student) => {
      const attempt = latest.get(student.id);
      if (!attempt) {
        return {
          studentUserId: student.id,
          fullName: student.fullName,
          status: "NOT_STARTED",
          attemptId: null,
          rawScore: null,
          maxScore: null,
          percentage: null,
          submittedAt: null,
          pendingMarks: 0,
          fullyMarked: false,
        };
      }

      const pendingMarks = attempt.answers.reduce(
        (sum, answer) =>
          answer.awardedMarks === null && answer.response !== null
            ? sum + Number(answer.maxMarks)
            : sum,
        0,
      );

      const inProgress = attempt.status === "IN_PROGRESS";

      return {
        studentUserId: student.id,
        fullName: student.fullName,
        status: inProgress
          ? "IN_PROGRESS"
          : attempt.submitReason === "SWEEP" || attempt.submitReason === "TIMEOUT"
            ? "EXPIRED"
            : "SUBMITTED",
        attemptId: attempt.id,
        rawScore: inProgress ? null : Number(attempt.rawScore ?? 0),
        maxScore: inProgress ? null : Number(attempt.maxScore ?? 0),
        percentage: inProgress ? null : Number(attempt.percentage ?? 0),
        submittedAt: attempt.submittedAt,
        pendingMarks,
        fullyMarked: !inProgress && pendingMarks === 0,
      };
    });

    const counted = rows
      .filter((row) => row.fullyMarked)
      .map((row) => row.percentage ?? 0)
      .sort((a, b) => a - b);

    const enough = counted.length >= MIN_TO_SUMMARISE;

    return {
      assignmentId,
      title: assignment.assessment.title,
      className: assignment.class.name,
      totalMarks: assignment.assessment.totalMarks,
      resultsPolicy: assignment.resultsPolicy,
      resultsReleasedAt: assignment.resultsReleasedAt,
      expected: rows.length,
      notStarted: rows.filter((row) => row.status === "NOT_STARTED").length,
      inProgress: rows.filter((row) => row.status === "IN_PROGRESS").length,
      submitted: rows.filter(
        (row) => row.status === "SUBMITTED" || row.status === "EXPIRED",
      ).length,
      awaitingMarking: rows.filter((row) => row.pendingMarks > 0).length,
      counted: counted.length,
      enoughToSummarise: enough,
      mean: enough ? round(average(counted)) : null,
      median: enough ? round(median(counted)) : null,
      highest: enough ? round(counted[counted.length - 1]!) : null,
      lowest: enough ? round(counted[0]!) : null,
      rows,
    };
  });
}

// ---------------------------------------------------------------------------
// Item analysis
// ---------------------------------------------------------------------------

export type OptionCount = {
  key: string;
  text: string;
  isCorrect: boolean;
  chosen: number;
};

export type Item = {
  assessmentQuestionId: string;
  position: number;
  type: string;
  stem: string;
  marks: number;
  /** Papers that reached this question — the denominator for everything else. */
  sat: number;
  attempted: number;
  /** Mean marks awarded as a fraction of the marks available, 0–1. */
  facility: number | null;
  averageMarks: number | null;
  pending: number;
  options: OptionCount[] | null;
  /**
   * The distractor more students chose than the key, if there is one. Usually
   * the single most useful line on this page: it names the specific wrong idea
   * the class holds, rather than reporting that they found the question hard.
   */
  topDistractor: { key: string; chosen: number } | null;
  /**
   * Wrong options a real share of the class chose, with WHO — so the teacher
   * can have the conversation with the five who hold that idea rather than
   * reteach thirty. Listed whether or not it beat the key: "6 of 30 think
   * the ratio flips" is worth a word even when 20 got it right. Staff-only,
   * like this whole page.
   */
  sharedWrong: { key: string; text: string; chosen: number; names: string[] }[];
  /** Worth a teacher's attention: most of the class did not get it. */
  needsAttention: boolean;
};

export async function itemAnalysis(
  organizationId: string,
  assignmentId: string,
): Promise<{ assignmentId: string; title: string; items: Item[] } | null> {
  return withTenant(organizationId, async (tx) => {
    const assignment = await tx.assignment.findFirst({
      where: { id: assignmentId },
      include: { assessment: { select: { id: true, title: true } } },
    });
    if (!assignment) return null;

    const attempts = await tx.attempt.findMany({
      where: { assignmentId, status: { not: "IN_PROGRESS" } },
      include: { answers: true },
    });

    const placements = await tx.assessmentQuestion.findMany({
      where: { assessmentId: assignment.assessmentId },
      orderBy: { position: "asc" },
      include: {
        question: { include: { versions: { orderBy: { version: "desc" } } } },
      },
    });
    const people = await tx.user.findMany({
      where: { id: { in: [...new Set(attempts.map((attempt) => attempt.studentUserId))] } },
      select: { id: true, fullName: true },
    });
    const nameOf = new Map(people.map((person) => [person.id, person.fullName]));
    const ownerOf = new Map(
      attempts.flatMap((attempt) => attempt.answers.map((answer) => [answer.id, attempt.studentUserId] as const)),
    );

    const items: Item[] = placements.map((placement) => {
      const type = placement.question.type as QuestionType;
      const version =
        placement.question.versions.find((v) => v.id === placement.questionVersionId) ??
        placement.question.versions[0];

      const answers = attempts.flatMap((attempt) => {
        const answer = attempt.answers.find(
          (a) => a.assessmentQuestionId === placement.id,
        );
        return answer ? [answer] : [];
      });

      const attempted = answers.filter((a) => a.response !== null).length;
      const marked = answers.filter((a) => a.awardedMarks !== null);
      const pending = answers.filter(
        (a) => a.awardedMarks === null && a.response !== null,
      ).length;

      // Nothing while a person still has some of these answers.
      //
      // The rule the cohort cards four rows up already follow: a statistic over
      // half-marked papers is not a smaller statistic, it is a WRONG one. This
      // line did not follow it — it averaged over whatever had been marked — so
      // a three-mark question with one of three answers marked printed "100%"
      // directly above its own sentence saying "2 answers are still to be
      // marked, so there is no figure yet".
      //
      // Refused here rather than in the component, because a number the product
      // will not stand behind should never reach a place where it can be
      // rendered — the same reason `Mastery` has no `estimate` field when the
      // band is INSUFFICIENT.
      const averageMarks =
        marked.length === 0 || pending > 0
          ? null
          : marked.reduce((sum, a) => sum + Number(a.awardedMarks), 0) / marked.length;

      const options = hasOptions(type)
        ? countOptions(version?.options as RawOption[] | null, answers)
        : null;

      const key = options?.find((option) => option.isCorrect);
      const distractors = (options ?? []).filter((option) => !option.isCorrect);
      const worst = distractors.reduce<OptionCount | null>(
        (best, option) => (best === null || option.chosen > best.chosen ? option : best),
        null,
      );

      const facility =
        averageMarks === null ? null : averageMarks / Number(placement.marks);

      return {
        assessmentQuestionId: placement.id,
        position: placement.position,
        type,
        stem: version?.stem ?? "",
        marks: placement.marks,
        sat: answers.length,
        attempted,
        facility: facility === null ? null : round(facility * 100) / 100,
        averageMarks: averageMarks === null ? null : round(averageMarks),
        pending,
        options,
        topDistractor:
          worst && key && worst.chosen > key.chosen
            ? { key: worst.key, chosen: worst.chosen }
            : null,
        sharedWrong: sharedWrong(
          distractors,
          answers.map((answer) => ({
            response: answer.response,
            name: nameOf.get(ownerOf.get(answer.id) ?? "") ?? "A student",
          })),
          attempted,
        ),
        // Below 40% of the marks available, on a question enough people sat to
        // mean anything. Under five papers, one strong student moves the
        // number by twenty points and the flag is noise.
        needsAttention:
          facility !== null && facility < 0.4 && answers.length >= 5,
      };
    });

    return { assignmentId, title: assignment.assessment.title, items };
  });
}

type RawOption = { key: string; text: string; isCorrect?: boolean };

/** Two students, and a fifth of those who answered: a shared idea, not a slip. */
export const SHARED_MIN_STUDENTS = 2;
export const SHARED_MIN_SHARE = 0.2;

export function sharedWrong(
  distractors: OptionCount[],
  answers: { response: unknown; name: string }[],
  attempted: number,
): Item["sharedWrong"] {
  return distractors
    .filter(
      (option) =>
        option.chosen >= SHARED_MIN_STUDENTS &&
        attempted > 0 &&
        option.chosen / attempted >= SHARED_MIN_SHARE,
    )
    .sort((a, b) => b.chosen - a.chosen)
    .map((option) => ({
      key: option.key,
      text: option.text,
      chosen: option.chosen,
      names: answers
        .filter((answer) => {
          const response = answer.response as { kind?: string; keys?: string[] } | null;
          return response?.kind === "choice" && (response.keys ?? []).includes(option.key);
        })
        .map((answer) => answer.name)
        .sort((a, b) => a.localeCompare(b)),
    }));
}

function countOptions(
  options: RawOption[] | null,
  answers: { response: unknown }[],
): OptionCount[] | null {
  if (!options) return null;

  const chosen = new Map<string, number>();
  for (const answer of answers) {
    const response = answer.response as { kind?: string; keys?: string[] } | null;
    if (response?.kind !== "choice") continue;
    for (const key of response.keys ?? []) {
      chosen.set(key, (chosen.get(key) ?? 0) + 1);
    }
  }

  return options.map((option) => ({
    key: option.key,
    text: option.text,
    isCorrect: option.isCorrect === true,
    chosen: chosen.get(option.key) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

export type ReleaseResult =
  | { ok: true; releasedAt: Date; alreadyReleased: boolean; pendingPapers: number }
  | { ok: false; message: string };

/**
 * Let the class see their results.
 *
 * Deliberately permitted while marking is outstanding, and deliberately
 * reports how many papers that is. A teacher who has marked twenty of
 * twenty-four should be able to give twenty students their result today —
 * slice 7 already shows the other four "marked so far" with the marks still
 * owed named, so nobody is shown a zero they did not earn. Blocking the
 * release until the last paper is marked would hold twenty students hostage to
 * four.
 */
export async function releaseResults(
  actor: Actor,
  assignmentId: string,
): Promise<ReleaseResult> {
  const now = new Date();

  const outcome = await withTenant<ReleaseResult>(
    actor.organizationId,
    async (tx) => {
      const assignment = await tx.assignment.findFirst({
        where: { id: assignmentId },
        include: {
          attempts: {
            where: { status: { not: "IN_PROGRESS" } },
            include: { answers: { select: { awardedMarks: true, response: true } } },
          },
        },
      });
      if (!assignment) {
        return { ok: false, message: "We could not find that assignment." };
      }
      if (assignment.cancelledAt) {
        return {
          ok: false,
          message: "This assignment was cancelled, so there is nothing to release.",
        };
      }

      const pendingPapers = assignment.attempts.filter((attempt) =>
        attempt.answers.some(
          (answer) => answer.awardedMarks === null && answer.response !== null,
        ),
      ).length;

      // Idempotent. A second press is a person who was not sure the first one
      // worked, and the honest answer is the time it happened.
      if (assignment.resultsReleasedAt) {
        return {
          ok: true,
          releasedAt: assignment.resultsReleasedAt,
          alreadyReleased: true,
          pendingPapers,
        };
      }

      await tx.assignment.update({
        where: { id: assignmentId },
        data: { resultsReleasedAt: now },
      });

      return { ok: true, releasedAt: now, alreadyReleased: false, pendingPapers };
    },
  );

  if (outcome.ok && !outcome.alreadyReleased) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "results.released",
      entityType: "assignment",
      entityId: assignmentId,
      after: { releasedAt: outcome.releasedAt, pendingPapers: outcome.pendingPapers },
    });
  }

  return outcome;
}

// ---------------------------------------------------------------------------

const average = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Values must already be sorted ascending. */
function median(values: number[]): number {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1]! + values[middle]!) / 2
    : values[middle]!;
}

const round = (value: number) => Math.round(value * 10) / 10;
