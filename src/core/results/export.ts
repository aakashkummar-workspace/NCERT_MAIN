import "server-only";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { assignmentResults, type Actor } from "./index";
import { csvFilename, toCsv, type Cell } from "./csv";

/**
 * Marks, as a file the school's own register can read.
 *
 * ---------------------------------------------------------------------------
 * Marks only. Never mastery.
 * ---------------------------------------------------------------------------
 * A mastery estimate is a belief that carries a denominator and a refusal band:
 * "0.42 over 6 answers", or nothing at all below the evidence threshold. Put it
 * in a spreadsheet and it loses both — it becomes a number in a column, and the
 * first thing anybody does with a column of numbers is average it and rank by
 * it. That is the composite this product refuses everywhere else, smuggled out
 * in a file. Marks are marks: somebody decided them, and they mean what they
 * say on the paper.
 *
 * ---------------------------------------------------------------------------
 * An unmarked answer exports blank, with the flag beside it
 * ---------------------------------------------------------------------------
 * `null` is not zero all the way to the last boundary. A paper still carrying a
 * written answer nobody has read exports its marks-so-far AND a `fully_marked`
 * column, because the number alone would be read as a final mark by the one
 * system that cannot ask.
 *
 * ---------------------------------------------------------------------------
 * Every export is audited
 * ---------------------------------------------------------------------------
 * A file holding a class's marks leaving the product is exactly what somebody
 * asks about a year later — who took it, and when.
 */

export type Export = { filename: string; csv: string };

/** One row per student on one paper. */
export async function assignmentMarksCsv(
  actor: Actor,
  assignmentId: string,
): Promise<Export | null> {
  const results = await assignmentResults(actor.organizationId, assignmentId);
  if (!results) return null;

  const rollByStudent = await rollNumbers(
    actor.organizationId,
    results.rows.map((row) => row.studentUserId),
  );

  const rows: Cell[][] = [
    [
      "roll_number",
      "student",
      "status",
      "marks",
      "out_of",
      "fully_marked",
      "marks_pending",
      "submitted_at",
    ],
    ...results.rows.map((row) => [
      rollByStudent.get(row.studentUserId) ?? "",
      row.fullName,
      row.status.toLowerCase(),
      // Blank, not 0, for a paper nobody sat or nobody has finished marking.
      row.rawScore,
      row.maxScore ?? results.totalMarks,
      row.attemptId ? (row.fullyMarked ? "yes" : "no") : "",
      row.pendingMarks > 0 ? row.pendingMarks : "",
      row.submittedAt,
    ]),
  ];

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "results.exported",
    entityType: "assignment",
    entityId: assignmentId,
    after: { students: results.rows.length, scope: "assignment" },
  });

  return {
    filename: csvFilename(results.className, results.title, "marks"),
    csv: toCsv(rows),
  };
}

/**
 * One row per student, one column per paper, for a class over a period.
 *
 * The register a school actually keeps. Where a student sat a paper more than
 * once it reports their BEST marked attempt — the same choice a term report
 * makes, and for the same reason: attempts exist so a student can improve, and
 * reporting the last go punishes trying again after a good one. Two readers
 * disagreeing about what a student scored is worse than either rule alone.
 */
export async function classMarksCsv(
  actor: Actor,
  classId: string,
  period: { from: Date; to: Date },
): Promise<Export | null> {
  const data = await withTenant(actor.organizationId, async (tx) => {
    const klass = await tx.class.findFirst({
      where: { id: classId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!klass) return null;

    const enrolments = await tx.classEnrolment.findMany({
      where: { classId, status: "ACTIVE" },
      select: { studentUserId: true },
    });
    const studentIds = enrolments.map((row) => row.studentUserId);

    const students = await tx.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, fullName: true },
    });

    const assignments = await tx.assignment.findMany({
      where: { classId, opensAt: { lte: period.to }, closesAt: { gte: period.from } },
      select: {
        id: true,
        opensAt: true,
        assessment: { select: { title: true, totalMarks: true } },
      },
      orderBy: { opensAt: "asc" },
    });

    const attempts = await tx.attempt.findMany({
      where: {
        assignmentId: { in: assignments.map((row) => row.id) },
        studentUserId: { in: studentIds },
        status: { not: "IN_PROGRESS" },
      },
      select: {
        assignmentId: true,
        studentUserId: true,
        rawScore: true,
        maxScore: true,
        answers: { select: { awardedMarks: true, response: true } },
      },
    });

    return { klass, students, assignments, attempts };
  });
  if (!data) return null;

  // Best marked attempt per student per paper, and whether anything on it is
  // still with a marker.
  type Best = { marks: number | null; fullyMarked: boolean };
  const best = new Map<string, Best>();
  for (const attempt of data.attempts) {
    const key = `${attempt.studentUserId}:${attempt.assignmentId}`;
    const pending = attempt.answers.filter(
      (answer) => answer.awardedMarks === null && answer.response !== null,
    ).length;
    const marks = attempt.rawScore === null ? null : Number(attempt.rawScore);
    const current = best.get(key);
    if (!current || (marks ?? -1) > (current.marks ?? -1)) {
      best.set(key, { marks, fullyMarked: pending === 0 });
    }
  }

  const header: Cell[] = ["roll_number", "student"];
  for (const assignment of data.assignments) {
    header.push(assignment.assessment.title, `${assignment.assessment.title} (out of)`);
  }

  const rollByStudent = await rollNumbers(actor.organizationId, data.students.map((s) => s.id));
  const sorted = [...data.students].sort((a, b) => a.fullName.localeCompare(b.fullName));

  const rows: Cell[][] = [header];
  for (const student of sorted) {
    const row: Cell[] = [rollByStudent.get(student.id) ?? "", student.fullName];
    for (const assignment of data.assignments) {
      const entry = best.get(`${student.id}:${assignment.id}`);
      // Three states, three different cells: never sat (blank), sat and part
      // marked ("3 (part marked)"), sat and finished (the number).
      row.push(
        entry === undefined
          ? ""
          : entry.marks === null
            ? ""
            : entry.fullyMarked
              ? entry.marks
              : `${entry.marks} (part marked)`,
        assignment.assessment.totalMarks,
      );
    }
    rows.push(row);
  }

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "results.exported",
    entityType: "class",
    entityId: classId,
    after: {
      students: sorted.length,
      papers: data.assignments.length,
      scope: "class",
      from: period.from.toISOString(),
      to: period.to.toISOString(),
    },
  });

  return {
    filename: csvFilename(data.klass.name, "marks", period.from.toISOString().slice(0, 10)),
    csv: toCsv(rows),
  };
}

async function rollNumbers(
  organizationId: string,
  studentIds: string[],
): Promise<Map<string, string>> {
  if (studentIds.length === 0) return new Map();
  const profiles = await withTenant(organizationId, (tx) =>
    tx.studentProfile.findMany({
      where: { userId: { in: studentIds } },
      select: { userId: true, rollNumber: true },
    }),
  );
  return new Map(
    profiles
      .filter((profile) => profile.rollNumber !== null)
      .map((profile) => [profile.userId, profile.rollNumber as string]),
  );
}
