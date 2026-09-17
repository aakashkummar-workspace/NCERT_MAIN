import "server-only";
import { withTenant } from "@/db/tenant";
import { assignmentStatus, type AssignmentStatus } from "./window";

/**
 * The papers set for one class, for the class page.
 *
 * "What is happening with 10-A" is the question a teacher opens that page with,
 * and until this existed the page could list the roster and not a single paper
 * the class had been given. Each row carries what somebody can act on — how
 * many handed in, how many written answers are still unread, whether results
 * are out — and links to where it is done.
 *
 * ---------------------------------------------------------------------------
 * Counts, and no marks
 * ---------------------------------------------------------------------------
 * No class average, no score column. A mean over a half-marked paper is a wrong
 * number, and the results page already computes the figures that can be stood
 * behind, with their denominators. This list sends a teacher there.
 */

export type ClassPaper = {
  assignmentId: string;
  assessmentId: string;
  title: string;
  status: AssignmentStatus;
  opensAt: Date;
  closesAt: Date;
  /** Everybody the paper was set for: the named students, or the whole class. */
  expected: number;
  /** Distinct students who have handed in (by pressing submit or by the clock). */
  handedIn: number;
  /** Distinct students with a sitting running right now. */
  writing: number;
  /** Written answers nobody has marked yet. A blank is settled, not waiting. */
  answersToMark: number;
  resultsReleasedAt: Date | null;
};

/** Enough for a class page. A class with more is linked to the full list. */
export const CLASS_PAPERS_LIMIT = 12;

export async function classPapers(
  organizationId: string,
  classId: string,
  now = new Date(),
): Promise<{ papers: ClassPaper[]; total: number }> {
  return withTenant(organizationId, async (tx) => {
    const [rows, total, classSize] = await Promise.all([
      tx.assignment.findMany({
        where: { classId },
        select: {
          id: true,
          assessmentId: true,
          opensAt: true,
          closesAt: true,
          cancelledAt: true,
          resultsReleasedAt: true,
          assessment: { select: { title: true } },
          _count: { select: { targets: true } },
        },
        // Newest window first: the paper this week matters more than September's.
        orderBy: { opensAt: "desc" },
        take: CLASS_PAPERS_LIMIT,
      }),
      tx.assignment.count({ where: { classId } }),
      tx.classEnrolment.count({ where: { classId, status: "ACTIVE" } }),
    ]);
    if (rows.length === 0) return { papers: [], total };

    const ids = rows.map((row) => row.id);
    const [attempts, unmarked] = await Promise.all([
      tx.attempt.findMany({
        where: { assignmentId: { in: ids } },
        select: { assignmentId: true, studentUserId: true, status: true },
      }),
      tx.attemptAnswer.findMany({
        where: {
          awardedMarks: null,
          attempt: { assignmentId: { in: ids }, status: { not: "IN_PROGRESS" } },
        },
        select: { response: true, attempt: { select: { assignmentId: true } } },
      }),
    ]);

    const students = (assignmentId: string, writing: boolean) =>
      new Set(
        attempts
          .filter(
            (attempt) =>
              attempt.assignmentId === assignmentId &&
              (attempt.status === "IN_PROGRESS") === writing,
          )
          .map((attempt) => attempt.studentUserId),
      ).size;

    const toMark = new Map<string, number>();
    for (const answer of unmarked) {
      // Same rule as the dashboard's workload: an unanswered question is
      // settled at submission and is not waiting on anybody.
      if (answer.response === null) continue;
      const key = answer.attempt.assignmentId;
      toMark.set(key, (toMark.get(key) ?? 0) + 1);
    }

    const papers = rows.map((row) => ({
      assignmentId: row.id,
      assessmentId: row.assessmentId,
      title: row.assessment.title,
      status: assignmentStatus(row, now),
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      expected: row._count.targets > 0 ? row._count.targets : classSize,
      handedIn: students(row.id, false),
      writing: students(row.id, true),
      answersToMark: toMark.get(row.id) ?? 0,
      resultsReleasedAt: row.resultsReleasedAt,
    }));

    return { papers, total };
  });
}
