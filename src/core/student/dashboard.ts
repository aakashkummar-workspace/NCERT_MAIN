import "server-only";
import { withTenant } from "@/db/tenant";
import { resultsVisible } from "@/core/assignments/window";
import {
  studentAssignments,
  studentResult,
  type StudentAssignment,
} from "@/core/attempts/student-view";
import { studentConceptStates } from "@/core/practice";
import { openForStudent } from "@/core/practice/assigned";
import { mistakeSummary } from "@/core/mistakes/read";
import { buildPlan, type PlanItem } from "@/core/plan/build";
import { examReadiness } from "@/core/readiness";
import { announcementsForStudent, type AnnouncementRow } from "@/core/announcements";
import { savedSummary, type SavedSummary } from "@/core/saved";
import { whoCanSeeMyProgress, type ProgressViewer } from "@/core/parent/read";
import {
  conceptSnapshot,
  effortSince,
  EFFORT_DAYS,
  hasNewFeedback,
  questionsToReview,
  resultMarks,
  type ResultMarks,
  type SubjectSnapshot,
} from "./rules";

/**
 * The student's home, as one read model.
 *
 * ---------------------------------------------------------------------------
 * It assembles; it does not decide
 * ---------------------------------------------------------------------------
 * Every figure on the dashboard is somebody else's answer, reused rather than
 * re-derived: the plan comes from `buildPlan`, the concept counts from the same
 * `studentConceptStates` the practice page reads, the release gate from
 * `resultsVisible` and `studentResult`, the readiness picture from
 * `examReadiness`. Two screens that each decide what a student is weak at, or
 * whether a mark is released, will disagree eventually — and a home page
 * contradicting the page it links to is worse than either being wrong alone.
 * What IS decided here lives in `rules.ts`, pure.
 *
 * ---------------------------------------------------------------------------
 * One section failing is not the page failing
 * ---------------------------------------------------------------------------
 * Every section is read independently and settled on its own. A slow readiness
 * query or a saved-questions table that is mid-migration must not cost a
 * student the list of papers they have to sit today. A section that fails is
 * logged and comes back as `{ ok: false }`, and the page says "couldn't load
 * this right now" in its place — quietly, and never as an empty state, because
 * "you have nothing saved" and "we could not check" are different sentences.
 *
 * ---------------------------------------------------------------------------
 * Nothing is stored
 * ---------------------------------------------------------------------------
 * No dashboard table, no cache, no counters. Every number is derived at read
 * time, for the reason an assignment's status is: a stored figure is stale the
 * moment the student practises, and keeping it fresh would need a job whose
 * rows are a lie between ticks. The one write this feature makes is the
 * `feedback_seen_at` stamp, and it is made by the result page, not here.
 */

export type Section<T> = { ok: true; data: T } | { ok: false };

export type LatestResult = {
  attemptId: string;
  title: string;
  submittedAt: Date | null;
  marks: ResultMarks;
  /** Marked questions short of full marks, blanks included. */
  toReview: number;
  /** Whether the answers can be opened yet — the result page's own gate. */
  reviewable: boolean;
};

export type FeedbackNotice = {
  attemptId: string;
  title: string;
  /**
   * The teacher's words, present ONLY when the review gate is open. Taken from
   * `studentResult`, which withholds feedback until then, so this module never
   * holds a comment the student is not yet allowed to read.
   */
  snippet: string | null;
  reviewable: boolean;
  /** Other released papers with new comments, beyond this one. */
  morePapers: number;
};

export type ConceptsSection = {
  subjects: SubjectSnapshot[];
};

export type PlanSection =
  | { ok: true; items: PlanItem[]; total: number }
  | { ok: false; reason: "nothing-yet" | "all-clear"; message: string };

export type MistakesSection = {
  /** Unresolved plus retried: retrying the SAME question is not proof. */
  open: number;
  resolvedThisWeek: number;
};

export type EffortSection = {
  days: number;
  setsFinished: number;
  questionsAnswered: number;
  mistakesFixed: number;
};

export type ReadinessSection =
  | { state: "no-syllabus" }
  | {
      state: "picture" | "refused";
      testedChapters: number;
      totalChapters: number;
      /** The readiness page's own sentence. Never a percentage. */
      line: string;
    };

export type AnnouncementsSection = {
  items: AnnouncementRow[];
  /** True when there are more than the ones shown, inside the 30-day window. */
  truncated: boolean;
};

export type StudentDashboard = {
  tests: Section<StudentAssignment[]>;
  latestResult: Section<LatestResult | null>;
  feedback: Section<FeedbackNotice | null>;
  concepts: Section<ConceptsSection>;
  plan: Section<PlanSection>;
  mistakes: Section<MistakesSection>;
  effort: Section<EffortSection>;
  readiness: Section<ReadinessSection>;
  announcements: Section<AnnouncementsSection>;
  saved: Section<SavedSummary>;
  viewers: Section<ProgressViewer[]>;
};

/** How many plan items Home shows before "See the whole plan". */
export const HOME_PLAN_ITEMS = 3;

/** How many announcements Home shows before "Showing the latest 3". */
export const HOME_ANNOUNCEMENTS = 3;

export async function studentDashboard(
  organizationId: string,
  studentUserId: string,
  now = new Date(),
): Promise<StudentDashboard> {
  const actor = { organizationId, userId: studentUserId };

  // The reads two sections share are started once and awaited by both, so the
  // plan does not re-read the assignments and concepts the page already has.
  const assignments = studentAssignments(organizationId, studentUserId);
  const concepts = studentConceptStates(actor, now);
  const mistakes = mistakeSummary(organizationId, studentUserId);
  const week = effortCounts(organizationId, studentUserId, now);
  // Practice a teacher asked for. Read here rather than inside the plan so
  // Home and /student/plan are built from the same inputs: two plans that
  // disagree on the same screen is worse than either being wrong alone.
  const assigned = openForStudent(organizationId, studentUserId);
  // Rejections are handled where each is awaited; these stop an early failure
  // being reported as unhandled before its consumer gets to it.
  for (const shared of [assignments, concepts, mistakes, week, assigned]) {
    shared.catch(() => {});
  }

  const [
    tests,
    results,
    conceptsSection,
    plan,
    mistakesSection,
    effort,
    readiness,
    announcements,
    saved,
    viewers,
  ] = await Promise.all([
    settle("tests", () => assignments),
    settle("results", () => resultsAndFeedback(organizationId, studentUserId, now)),
    settle("concepts", async () => ({ subjects: conceptSnapshot(await concepts) })),
    settle("plan", async () =>
      planSection(await assignments, await concepts, await mistakes, await assigned, now),
    ),
    settle("mistakes", async () => {
      const [summary, effort] = await Promise.all([mistakes, week]);
      return { open: summary.open + summary.retried, resolvedThisWeek: effort.mistakesFixed };
    }),
    settle("effort", () => week),
    settle("readiness", () => readinessSection(actor)),
    settle("announcements", async () => {
      // One more than is shown, so "Showing the latest 3" is said only when it
      // is true — a truncated list says so, and an untruncated one does not.
      const rows = await announcementsForStudent(organizationId, studentUserId, {
        limit: HOME_ANNOUNCEMENTS + 1,
        now,
      });
      return {
        items: rows.slice(0, HOME_ANNOUNCEMENTS),
        truncated: rows.length > HOME_ANNOUNCEMENTS,
      };
    }),
    settle("saved", () => savedSummary(organizationId, studentUserId, 3)),
    settle("viewers", () => whoCanSeeMyProgress(actor, now)),
  ]);

  return {
    tests,
    latestResult: results.ok ? { ok: true, data: results.data.latest } : { ok: false },
    feedback: results.ok ? { ok: true, data: results.data.feedback } : { ok: false },
    concepts: conceptsSection,
    plan,
    mistakes: mistakesSection,
    effort,
    readiness,
    announcements,
    saved,
    viewers,
  };
}

/**
 * Run one section's read and never let it throw.
 *
 * Logged with the section's name and nothing else: an error object from a
 * query can carry the parameters it was run with, and a student id in a log
 * line is a student id in a log file.
 */
async function settle<T>(name: string, read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (error) {
    console.error(`student dashboard: the ${name} section failed`, {
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Up next
// ---------------------------------------------------------------------------

/**
 * The study plan, from the reads Home already made.
 *
 * `buildPlan` is called directly rather than through `studyPlan()` so the
 * assignments, concept states and mistake summary are read once for the whole
 * page, not twice. The inputs are exactly the ones `core/plan/index.ts` hands
 * it — `StudentAssignment` is structurally a `PlanTest`, and the mistake count
 * is unresolved plus retried for the reason given there — so the plan on Home
 * and on `/student/plan` is the same plan.
 */
function planSection(
  assignments: StudentAssignment[],
  concepts: Awaited<ReturnType<typeof studentConceptStates>>,
  mistakes: Awaited<ReturnType<typeof mistakeSummary>>,
  assigned: Awaited<ReturnType<typeof openForStudent>>,
  now: Date,
): PlanSection {
  const plan = buildPlan(
    {
      tests: assignments,
      concepts,
      openMistakes: mistakes.open + mistakes.retried,
      mistakeConceptName: mistakes.worst?.conceptName ?? null,
      assignedPractice: assigned.map((set) => ({
        id: set.id,
        conceptId: set.conceptId,
        conceptName: set.conceptName,
        questionCount: set.questionCount,
        dueAt: set.dueAt,
        className: set.className,
        inProgress: set.state === "IN_PROGRESS",
      })),
    },
    now,
  );
  if (!plan.ok) return plan;
  // The plan's own order, cut at three. Home used to show only the first
  // item that was not a deadline; now the papers are summarised above it and
  // the first three items say what to do in the order the plan decided.
  return {
    ok: true,
    items: plan.items.slice(0, HOME_PLAN_ITEMS),
    total: plan.items.length,
  };
}

// ---------------------------------------------------------------------------
// Latest result and teacher feedback
// ---------------------------------------------------------------------------

/** How many finished sittings are looked through for a released one. */
const RECENT_SITTINGS = 30;

async function resultsAndFeedback(
  organizationId: string,
  studentUserId: string,
  now: Date,
): Promise<{ latest: LatestResult | null; feedback: FeedbackNotice | null }> {
  const read = await withTenant(organizationId, async (tx) => {
    const attempts = await tx.attempt.findMany({
      where: { studentUserId, status: { not: "IN_PROGRESS" } },
      orderBy: [{ submittedAt: "desc" }, { startedAt: "desc" }],
      take: RECENT_SITTINGS,
      select: {
        id: true,
        feedbackSeenAt: true,
        assignment: {
          select: {
            resultsPolicy: true,
            closesAt: true,
            resultsReleasedAt: true,
            cancelledAt: true,
          },
        },
      },
    });

    // The release gate, through the one function that owns it. A result the
    // teacher has not released is not a "latest result", and a comment on it
    // is not feedback the student can be told about yet.
    const released = attempts.filter(
      (attempt) =>
        attempt.assignment.cancelledAt === null &&
        resultsVisible(attempt.assignment, now),
    );
    if (released.length === 0) return { released, commented: [] };

    // Which answers carry a comment, and when it was written. The comment text
    // is NOT selected: it reaches this module only through `studentResult`,
    // which withholds it until the review gate opens.
    const commented = await tx.attemptAnswer.findMany({
      where: {
        attemptId: { in: released.map((attempt) => attempt.id) },
        AND: [{ feedback: { not: null } }, { feedback: { not: "" } }],
      },
      select: { attemptId: true, gradedAt: true },
    });
    return { released, commented };
  });

  if (read.released.length === 0) return { latest: null, feedback: null };

  const withNewFeedback = read.released.filter((attempt) =>
    hasNewFeedback(
      read.commented
        .filter((row) => row.attemptId === attempt.id)
        .map((row) => row.gradedAt),
      attempt.feedbackSeenAt,
    ),
  );

  const latestId = read.released[0]!.id;
  const feedbackId = withNewFeedback[0]?.id ?? null;

  const [latest, commented] = await Promise.all([
    studentResult(organizationId, studentUserId, latestId),
    feedbackId === null
      ? null
      : feedbackId === latestId
        ? undefined
        : studentResult(organizationId, studentUserId, feedbackId),
  ]);
  const feedbackResult = commented === undefined ? latest : commented;

  return {
    latest:
      latest && latest.visible
        ? {
            attemptId: latest.attemptId,
            title: latest.title,
            submittedAt: latest.submittedAt,
            marks: resultMarks(latest),
            toReview: questionsToReview(latest.breakdown),
            reviewable: latest.reviewable,
          }
        : null,
    feedback:
      feedbackResult && feedbackResult.visible
        ? {
            attemptId: feedbackResult.attemptId,
            title: feedbackResult.title,
            snippet: feedbackResult.reviewable
              ? (feedbackResult.breakdown.find((item) => item.feedback)?.feedback ?? null)
              : null,
            reviewable: feedbackResult.reviewable,
            morePapers: Math.max(0, withNewFeedback.length - 1),
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Effort, readiness
// ---------------------------------------------------------------------------

/**
 * What the student DID in the last seven days. Effort, never correctness.
 *
 * No right-answer rate, because practice is where getting things wrong is the
 * point and a percentage beside "questions answered" turns an effort card into
 * a score. No streak, because a streak punishes the one evening a student
 * spends at a wedding and rewards grinding easy questions to keep a number
 * alive — the opposite of what practice is for.
 *
 * Read once and shared: "Things to fix" shows the same mistakes-fixed count,
 * and two queries for one fact are two chances to disagree.
 */
async function effortCounts(
  organizationId: string,
  studentUserId: string,
  now: Date,
): Promise<EffortSection> {
  const since = effortSince(now);
  return withTenant(organizationId, async (tx) => {
    const [setsFinished, questionsAnswered, mistakesFixed] = await Promise.all([
      tx.practiceSession.count({
        where: { studentUserId, completedAt: { gte: since, lte: now } },
      }),
      tx.practiceAnswer.count({
        where: {
          session: { studentUserId },
          answeredAt: { gte: since, lte: now },
        },
      }),
      tx.studentMistake.count({
        where: { studentUserId, status: "RESOLVED", resolvedAt: { gte: since, lte: now } },
      }),
    ]);
    return { days: EFFORT_DAYS, setsFinished, questionsAnswered, mistakesFixed };
  });
}

/**
 * The readiness teaser: chapters tested, out of the syllabus.
 *
 * Carried through the refusal as well as the picture — "tested on 3 of 51
 * chapters" needs no threshold to be true, which is exactly why
 * `examReadiness` carries `coverage` on both arms. The count is over every
 * subject the student is enrolled in, fixture chapters already excluded
 * there, and the page says "across your subjects" rather than implying one.
 */
async function readinessSection(actor: {
  organizationId: string;
  userId: string;
}): Promise<ReadinessSection> {
  const readiness = await examReadiness(actor);
  if (!readiness.ok && readiness.reason === "no-syllabus") return { state: "no-syllabus" };
  if (readiness.coverage.totalChapters === 0) return { state: "no-syllabus" };
  return {
    state: readiness.ok ? "picture" : "refused",
    testedChapters: readiness.coverage.testedChapters,
    totalChapters: readiness.coverage.totalChapters,
    line: readiness.ok ? readiness.summary : readiness.headline,
  };
}
