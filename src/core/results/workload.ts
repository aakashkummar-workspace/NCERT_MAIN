import "server-only";
import { withTenant } from "@/db/tenant";
import { assignmentStatus } from "@/core/assignments/window";

/**
 * What is waiting on the teacher, for the dashboard.
 *
 * Counts of things somebody can act on this week — papers to mark, papers open
 * now, results recently released — and deliberately no score of any kind. The
 * dashboard used to carry a "Class mastery" card that read "not enough evidence
 * yet" whatever had happened, which was false after the first marked paper and
 * would have been the single class score the product refuses everywhere else
 * had it ever been filled in.
 *
 * Every row names the assignment it is about, so each figure links to the page
 * where it is dealt with. A number that cannot be acted on gets ignored, and
 * then so do the others.
 */

export type MarkingRow = {
  assignmentId: string;
  title: string;
  className: string;
  /** Papers with at least one written answer nobody has marked. */
  papers: number;
  /** The written answers themselves. */
  answers: number;
};

export type OpenRow = {
  assignmentId: string;
  title: string;
  className: string;
  closesAt: Date;
  /** Distinct students who have handed a paper in. */
  submitted: number;
  /**
   * Distinct students with a sitting still running, by the rule the live view
   * uses: the attempt is IN_PROGRESS. A count only — who, and how far on, is
   * the monitor's job, and it carries no marks either way.
   */
  writing: number;
};

/**
 * Students on a class roster who cannot sign in, because a phone number is the
 * only way a student does. Discovering that on the morning of a paper is the
 * failure this exists to prevent, so it sits on the dashboard as well as on the
 * class and students pages.
 */
export type CannotSignInRow = {
  classId: string;
  className: string;
  students: number;
};

export type ReleasedRow = {
  assignmentId: string;
  title: string;
  className: string;
  releasedAt: Date;
};

export type Workload = {
  marking: MarkingRow[];
  /** Totals across every assignment, so the card and the list cannot disagree. */
  papersToMark: number;
  answersToMark: number;
  open: OpenRow[];
  released: ReleasedRow[];
  cannotSignIn: CannotSignInRow[];
};

/** How far back "recently released" reaches. */
export const RECENT_RELEASE_DAYS = 14;

const DAY = 86_400_000;

export async function teacherWorkload(
  organizationId: string,
  now = new Date(),
): Promise<Workload> {
  return withTenant(organizationId, async (tx) => {
    // Unmarked, and actually answered: a blank is settled at submission and is
    // not waiting on anybody. Same rule the results page counts by.
    const unmarked = await tx.attemptAnswer.findMany({
      where: { awardedMarks: null, attempt: { status: { not: "IN_PROGRESS" } } },
      select: { attemptId: true, response: true, attempt: { select: { assignmentId: true } } },
    });
    const pending = unmarked.filter((answer) => answer.response !== null);

    const byAssignment = new Map<string, { papers: Set<string>; answers: number }>();
    for (const answer of pending) {
      const entry = byAssignment.get(answer.attempt.assignmentId) ?? {
        papers: new Set<string>(),
        answers: 0,
      };
      entry.papers.add(answer.attemptId);
      entry.answers++;
      byAssignment.set(answer.attempt.assignmentId, entry);
    }

    const assignments = await tx.assignment.findMany({
      where: {
        OR: [
          { id: { in: [...byAssignment.keys()] } },
          { cancelledAt: null, opensAt: { lte: now }, closesAt: { gt: now } },
          { resultsReleasedAt: { gte: new Date(now.getTime() - RECENT_RELEASE_DAYS * DAY) } },
        ],
      },
      select: {
        id: true,
        opensAt: true,
        closesAt: true,
        cancelledAt: true,
        resultsReleasedAt: true,
        assessment: { select: { title: true } },
        class: { select: { name: true } },
      },
    });
    const byId = new Map(assignments.map((row) => [row.id, row]));

    const marking: MarkingRow[] = [...byAssignment.entries()]
      .flatMap(([assignmentId, entry]) => {
        const assignment = byId.get(assignmentId);
        if (!assignment) return [];
        return [
          {
            assignmentId,
            title: assignment.assessment.title,
            className: assignment.class.name,
            papers: entry.papers.size,
            answers: entry.answers,
          },
        ];
      })
      .sort((a, b) => b.papers - a.papers || b.answers - a.answers);

    const openAssignments = assignments.filter(
      (row) => assignmentStatus(row, now) === "OPEN",
    );
    const openAttempts =
      openAssignments.length === 0
        ? []
        : await tx.attempt.findMany({
            where: { assignmentId: { in: openAssignments.map((row) => row.id) } },
            select: { assignmentId: true, studentUserId: true, status: true },
          });
    const distinctStudents = (assignmentId: string, writing: boolean) =>
      new Set(
        openAttempts
          .filter(
            (attempt) =>
              attempt.assignmentId === assignmentId &&
              (attempt.status === "IN_PROGRESS") === writing,
          )
          .map((attempt) => attempt.studentUserId),
      ).size;

    const open: OpenRow[] = openAssignments
      .map((row) => ({
        assignmentId: row.id,
        title: row.assessment.title,
        className: row.class.name,
        closesAt: row.closesAt,
        submitted: distinctStudents(row.id, false),
        writing: distinctStudents(row.id, true),
      }))
      // Closing soonest first: that is the one a reminder still helps with.
      .sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime());

    const released: ReleasedRow[] = assignments
      .filter(
        (row) =>
          row.resultsReleasedAt !== null &&
          row.resultsReleasedAt.getTime() >= now.getTime() - RECENT_RELEASE_DAYS * DAY,
      )
      .map((row) => ({
        assignmentId: row.id,
        title: row.assessment.title,
        className: row.class.name,
        releasedAt: row.resultsReleasedAt!,
      }))
      .sort((a, b) => b.releasedAt.getTime() - a.releasedAt.getTime());

    // Enrolments carry no relation to users, so this is two reads: who is on a
    // live roster, then which of them has no phone.
    const enrolments = await tx.classEnrolment.findMany({
      where: { status: "ACTIVE", class: { deletedAt: null } },
      select: { studentUserId: true, class: { select: { id: true, name: true } } },
    });
    const noPhone =
      enrolments.length === 0
        ? new Set<string>()
        : new Set(
            (
              await tx.user.findMany({
                where: {
                  id: { in: [...new Set(enrolments.map((row) => row.studentUserId))] },
                  phone: null,
                },
                select: { id: true },
              })
            ).map((user) => user.id),
          );
    // A printed card is a way in too, so a student holding one is not stuck.
    const carded =
      noPhone.size === 0
        ? new Set<string>()
        : new Set(
            (
              await tx.loginCard.findMany({
                where: { studentUserId: { in: [...noPhone] }, revokedAt: null },
                select: { studentUserId: true },
              })
            ).map((card) => card.studentUserId),
          );
    const byClass = new Map<string, CannotSignInRow>();
    for (const enrolment of enrolments) {
      if (!noPhone.has(enrolment.studentUserId)) continue;
      if (carded.has(enrolment.studentUserId)) continue;
      const row = byClass.get(enrolment.class.id) ?? {
        classId: enrolment.class.id,
        className: enrolment.class.name,
        students: 0,
      };
      row.students++;
      byClass.set(enrolment.class.id, row);
    }
    const cannotSignIn = [...byClass.values()].sort((a, b) => b.students - a.students);

    return {
      cannotSignIn,
      marking,
      papersToMark: marking.reduce((sum, row) => sum + row.papers, 0),
      answersToMark: marking.reduce((sum, row) => sum + row.answers, 0),
      open,
      released,
    };
  });
}
