import "server-only";
import { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { expectedStudentIds } from "./cohort";
import { assignmentStatus } from "./window";

/**
 * Who is sitting this paper, right now.
 *
 * ---------------------------------------------------------------------------
 * Derived at read time, stored nowhere
 * ---------------------------------------------------------------------------
 * The same rule as an assignment's status, and for the same reason: a stored
 * "who is live" is a row that is a lie between ticks — a student shown as
 * writing who submitted four minutes ago, or the reverse. Every state below is
 * a function of three stamps and the clock.
 *
 * ---------------------------------------------------------------------------
 * No marks, and that is the feature
 * ---------------------------------------------------------------------------
 * A percentage over a half-answered paper moves every minute and describes
 * nothing — and a teacher watching it during an exam is watching one child. So
 * this payload carries no score at all: not `rawScore`, not `percentage`, not
 * per-answer correctness, and the query does not select them. Progress is
 * *answered N of M*, which is the one thing an invigilator can act on: the
 * student who has answered nothing with ten minutes left is the one to walk
 * over to.
 *
 * `tab_switches` exists on the attempt and stays where it is. A proctoring
 * dashboard is a different product and a different conversation about consent.
 */

export type SittingState =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "AUTO_SUBMITTED";

export type Sitting = {
  studentUserId: string;
  fullName: string;
  state: SittingState;
  /** Null until they start. */
  startedAt: Date | null;
  submittedAt: Date | null;
  /** Milliseconds left on their own clock; null unless in progress. */
  timeLeftMs: number | null;
  /** How many questions carry an answer, and how many there are. */
  answered: number;
  questionCount: number;
  /** Which go this is, for a paper that allows more than one. */
  attemptNumber: number | null;
};

export type LiveView = {
  assignmentId: string;
  assessmentTitle: string;
  className: string;
  status: ReturnType<typeof assignmentStatus>;
  opensAt: Date;
  closesAt: Date;
  questionCount: number;
  /** The clock this paper runs on, override included. */
  durationMinutes: number;
  counts: {
    expected: number;
    notStarted: number;
    inProgress: number;
    submitted: number;
    autoSubmitted: number;
  };
  sittings: Sitting[];
  /** When this reading was taken. A live view has to say how old it is. */
  readAt: Date;
};

export async function liveView(
  organizationId: string,
  assignmentId: string,
  now = new Date(),
): Promise<LiveView | null> {
  return withTenant(organizationId, async (tx) => {
    const assignment = await tx.assignment.findFirst({
      where: { id: assignmentId },
      include: {
        assessment: {
          select: {
            title: true,
            durationMinutes: true,
            _count: { select: { questions: true } },
          },
        },
        class: { select: { name: true } },
        targets: true,
      },
    });
    if (!assignment) return null;

    const studentIds = await expectedStudentIds(tx, assignment);
    const students = await tx.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, fullName: true },
    });

    // No score columns here, deliberately — see the note at the top.
    const attempts = await tx.attempt.findMany({
      where: { assignmentId },
      select: {
        id: true,
        studentUserId: true,
        status: true,
        submitReason: true,
        attemptNumber: true,
        startedAt: true,
        submittedAt: true,
        expiresAt: true,
      },
      orderBy: { attemptNumber: "desc" },
    });

    // The one that matters is the LATEST: a student on their second go is
    // sitting the second one, and their first is history.
    const latest = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      if (!latest.has(attempt.studentUserId)) latest.set(attempt.studentUserId, attempt);
    }

    // Answered counts, over the attempts on this paper only.
    const answers = await tx.attemptAnswer.groupBy({
      by: ["attemptId"],
      where: {
        attemptId: { in: [...latest.values()].map((attempt) => attempt.id) },
        // A blank is not an answer. A student who opened a question and typed
        // nothing has not answered it, and counting it would tell an
        // invigilator the room is further on than it is.
        response: { not: Prisma.DbNull },
      },
      _count: { _all: true },
    });
    const answeredByAttempt = new Map(
      answers.map((row) => [row.attemptId, row._count._all]),
    );

    const questionCount = assignment.assessment._count.questions;
    const sittings: Sitting[] = students
      .map((student) => {
        const attempt = latest.get(student.id);
        if (!attempt || !attempt.startedAt) {
          return {
            studentUserId: student.id,
            fullName: student.fullName,
            state: "NOT_STARTED" as const,
            startedAt: null,
            submittedAt: null,
            timeLeftMs: null,
            answered: 0,
            questionCount,
            attemptNumber: null,
          };
        }

        const answered = answeredByAttempt.get(attempt.id) ?? 0;
        if (attempt.status === "IN_PROGRESS") {
          return {
            studentUserId: student.id,
            fullName: student.fullName,
            state: "IN_PROGRESS" as const,
            startedAt: attempt.startedAt,
            submittedAt: null,
            // From the stamp, never counted down — the same clock the player
            // renders, so the two cannot disagree. Floored at zero: a paper
            // past its expiry is waiting for the sweep, not running backwards.
            timeLeftMs: attempt.expiresAt
              ? Math.max(0, attempt.expiresAt.getTime() - now.getTime())
              : null,
            answered,
            questionCount,
            attemptNumber: attempt.attemptNumber,
          };
        }

        return {
          studentUserId: student.id,
          fullName: student.fullName,
          // "The clock ended it" and "they pressed submit" are different facts
          // about a student, and only one of them is a choice.
          state:
            attempt.submitReason === "TIMEOUT"
              ? ("AUTO_SUBMITTED" as const)
              : ("SUBMITTED" as const),
          startedAt: attempt.startedAt,
          submittedAt: attempt.submittedAt,
          timeLeftMs: null,
          answered,
          questionCount,
          attemptNumber: attempt.attemptNumber,
        };
      })
      // Whoever needs the invigilator first: still writing, then not started,
      // then finished. Inside a group, least progress first — the student with
      // nothing answered is the one to walk over to.
      .sort((a, b) => {
        const order: Record<SittingState, number> = {
          IN_PROGRESS: 0,
          NOT_STARTED: 1,
          AUTO_SUBMITTED: 2,
          SUBMITTED: 3,
        };
        if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
        if (a.answered !== b.answered) return a.answered - b.answered;
        return a.fullName.localeCompare(b.fullName);
      });

    const counts = {
      expected: sittings.length,
      notStarted: sittings.filter((s) => s.state === "NOT_STARTED").length,
      inProgress: sittings.filter((s) => s.state === "IN_PROGRESS").length,
      submitted: sittings.filter((s) => s.state === "SUBMITTED").length,
      autoSubmitted: sittings.filter((s) => s.state === "AUTO_SUBMITTED").length,
    };

    return {
      assignmentId: assignment.id,
      assessmentTitle: assignment.assessment.title,
      className: assignment.class.name,
      status: assignmentStatus(assignment, now),
      opensAt: assignment.opensAt,
      closesAt: assignment.closesAt,
      questionCount,
      durationMinutes:
        assignment.durationOverrideMinutes ?? assignment.assessment.durationMinutes,
      counts,
      sittings,
      readAt: now,
    };
  });
}
