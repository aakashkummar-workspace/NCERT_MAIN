import "server-only";
import { withTenant } from "@/db/tenant";
import { conceptContext } from "@/core/curriculum/concepts";
import { MIN_MEASURED } from "@/core/analytics/class";

/**
 * Comparing batches.
 *
 * ---------------------------------------------------------------------------
 * A comparison is only honest with its denominators attached
 * ---------------------------------------------------------------------------
 * "10-A is at 71% and 10-B is at 58%" is the sentence an owner wants and the
 * sentence that is almost always wrong. 10-A may have four measured students of
 * thirty; 10-B may have twenty-eight. The figure is arithmetically correct and
 * describes nothing.
 *
 * So every row carries `measured` and `total`, the mean is null below
 * `MIN_MEASURED` — the same bar the teacher's class analytics uses, because two
 * screens disagreeing about when a number exists is worse than either rule —
 * and the UI has the denominator available on every figure it prints.
 *
 * ---------------------------------------------------------------------------
 * Batches are compared, teachers are not
 * ---------------------------------------------------------------------------
 * A batch difference is a fact about a group of students. It becomes a claim
 * about a teacher only if you assume the two groups were comparable to begin
 * with, and they never are: streaming, timetabling and who joined in August all
 * move this more than teaching does. So this returns classes, and
 * `core/institute/kpis.ts` deliberately does not join it to the teacher table.
 */

export type BatchRow = {
  classId: string;
  className: string;
  subjectName: string;
  academicYear: string;
  students: number;
  /** Students with a real estimate on at least one concept. */
  measured: number;
  /** Null below MIN_MEASURED. Never a mean over four students called a class. */
  meanEstimate: number | null;
  /** Concepts where enough of this class is below the line. */
  openGaps: number;
  attemptsSubmitted: number;
  /** Papers still waiting on a person. */
  unmarkedPapers: number;
};

export async function batches(
  organizationId: string,
  now = new Date(),
): Promise<BatchRow[]> {
  void now;

  return withTenant(organizationId, async (tx) => {
    const classes = await tx.class.findMany({
      where: { deletedAt: null },
      include: { subject: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    if (classes.length === 0) return [];

    const classIds = classes.map((klass) => klass.id);

    const [enrolments, gaps] = await Promise.all([
      tx.classEnrolment.findMany({
        where: { classId: { in: classIds }, status: "ACTIVE" },
        select: { classId: true, studentUserId: true },
      }),
      tx.learningGap.groupBy({
        by: ["scopeId"],
        where: {
          scope: "CLASS",
          scopeId: { in: classIds },
          status: { in: ["DETECTED", "ACKNOWLEDGED", "INTERVENING", "PERSISTING"] },
        },
        _count: true,
      }),
    ]);

    const studentsByClass = new Map<string, string[]>();
    for (const enrolment of enrolments) {
      const list = studentsByClass.get(enrolment.classId) ?? [];
      list.push(enrolment.studentUserId);
      studentsByClass.set(enrolment.classId, list);
    }

    const allStudentIds = [...new Set(enrolments.map((e) => e.studentUserId))];

    const [mastery, attempts, unmarked] = await Promise.all([
      allStudentIds.length === 0
        ? []
        : tx.studentConceptMastery.findMany({
            where: { studentUserId: { in: allStudentIds }, estimate: { not: null } },
            select: { studentUserId: true, estimate: true },
          }),
      tx.assignment.findMany({
        where: { classId: { in: classIds } },
        select: { id: true, classId: true },
      }),
      tx.attemptAnswer.findMany({
        where: { gradedAt: null, awardedMarks: null },
        select: { attemptId: true },
      }),
    ]);

    const assignmentToClass = new Map(attempts.map((a) => [a.id, a.classId]));
    const submitted = await tx.attempt.findMany({
      where: {
        assignmentId: { in: attempts.map((a) => a.id) },
        status: { not: "IN_PROGRESS" },
      },
      select: { id: true, assignmentId: true },
    });

    const pendingAttempts = new Set(unmarked.map((row) => row.attemptId));
    const submittedByClass = new Map<string, number>();
    const unmarkedByClass = new Map<string, number>();
    for (const attempt of submitted) {
      const classId = assignmentToClass.get(attempt.assignmentId);
      if (!classId) continue;
      submittedByClass.set(classId, (submittedByClass.get(classId) ?? 0) + 1);
      if (pendingAttempts.has(attempt.id)) {
        unmarkedByClass.set(classId, (unmarkedByClass.get(classId) ?? 0) + 1);
      }
    }

    // Mean per student first, then across students — not a flat mean over every
    // row. Averaging rows lets a student with thirty measured concepts count
    // seven times as much as one with four, so the "class average" would move
    // when one keen student sat another paper.
    const byStudent = new Map<string, number[]>();
    for (const row of mastery) {
      const list = byStudent.get(row.studentUserId) ?? [];
      list.push(Number(row.estimate));
      byStudent.set(row.studentUserId, list);
    }
    const studentMeans = new Map(
      [...byStudent].map(([studentId, values]) => [
        studentId,
        values.reduce((sum, value) => sum + value, 0) / values.length,
      ]),
    );

    const gapsByClass = new Map(gaps.map((row) => [row.scopeId, row._count]));

    return classes.map((klass) => {
      const students = studentsByClass.get(klass.id) ?? [];
      const measured = students.filter((id) => studentMeans.has(id));

      return {
        classId: klass.id,
        className: klass.name,
        subjectName: klass.subject.name,
        academicYear: klass.academicYear,
        students: students.length,
        measured: measured.length,
        // The refusal, at the same bar the teacher's own analytics uses. Two
        // screens disagreeing about when a number exists is worse than either
        // rule on its own.
        meanEstimate:
          measured.length < MIN_MEASURED
            ? null
            : Math.round(
                (measured.reduce((sum, id) => sum + studentMeans.get(id)!, 0) /
                  measured.length) *
                  1000,
              ) / 1000,
        openGaps: gapsByClass.get(klass.id) ?? 0,
        attemptsSubmitted: submittedByClass.get(klass.id) ?? 0,
        unmarkedPapers: unmarkedByClass.get(klass.id) ?? 0,
      };
    });
  });
}

export type ConceptRow = {
  conceptId: string;
  conceptName: string;
  /** Per class, so an owner can see WHERE the difference is. */
  perClass: {
    classId: string;
    className: string;
    measured: number;
    meanEstimate: number | null;
  }[];
  /** How many classes have enough evidence to be compared at all. */
  comparable: number;
};

/**
 * The same concept across every batch.
 *
 * The genuinely useful comparison, and the one a spreadsheet cannot do: if
 * every batch is weak on the same concept it is the syllabus or the material,
 * and if one batch is weak on it alone it is that room. Those need different
 * responses, and telling them apart is most of what an owner is for.
 */
export async function conceptsAcrossBatches(
  organizationId: string,
): Promise<ConceptRow[]> {
  const rows = await withTenant(organizationId, async (tx) => {
    const classes = await tx.class.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    if (classes.length === 0) return null;

    const enrolments = await tx.classEnrolment.findMany({
      where: { classId: { in: classes.map((k) => k.id) }, status: "ACTIVE" },
      select: { classId: true, studentUserId: true },
    });
    if (enrolments.length === 0) return null;

    const mastery = await tx.studentConceptMastery.findMany({
      where: {
        studentUserId: { in: [...new Set(enrolments.map((e) => e.studentUserId))] },
        estimate: { not: null },
      },
      select: { studentUserId: true, conceptId: true, estimate: true },
    });

    return { classes, enrolments, mastery };
  });
  if (!rows) return [];

  const { classes, enrolments, mastery } = rows;

  // A student may sit in more than one class, so this is one-to-MANY.
  //
  // It was `new Map(enrolments.map((row) => [studentUserId, classId]))`, which
  // silently keeps only the last enrolment: a student in 10-A and in the Maths
  // set reached exactly one of the two grids, and the other room under-counted
  // its own `measured` without anything looking wrong. The figure that column
  // then carries is a real mean over the wrong denominator, which is the
  // failure this file's own MIN_MEASURED rule exists to prevent.
  //
  // They belong in both: they are in both rooms, and a teacher looking at
  // either one is asking about the students actually in front of them.
  const classesByStudent = new Map<string, string[]>();
  for (const row of enrolments) {
    const existing = classesByStudent.get(row.studentUserId);
    if (existing) existing.push(row.classId);
    else classesByStudent.set(row.studentUserId, [row.classId]);
  }
  const classNameById = new Map(classes.map((k) => [k.id, k.name]));

  // concept -> class -> estimates
  const grid = new Map<string, Map<string, number[]>>();
  for (const row of mastery) {
    const classIds = classesByStudent.get(row.studentUserId);
    if (!classIds) continue;
    const byClass = grid.get(row.conceptId) ?? new Map<string, number[]>();
    for (const classId of classIds) {
      const values = byClass.get(classId) ?? [];
      values.push(Number(row.estimate));
      byClass.set(classId, values);
    }
    grid.set(row.conceptId, byClass);
  }
  if (grid.size === 0) return [];

  const context = await conceptContext([...grid.keys()]);

  return [...grid]
    .map(([conceptId, byClass]) => {
      const perClass = classes.map((klass) => {
        const values = byClass.get(klass.id) ?? [];
        return {
          classId: klass.id,
          className: classNameById.get(klass.id) ?? klass.name,
          measured: values.length,
          meanEstimate:
            values.length < MIN_MEASURED
              ? null
              : Math.round(
                  (values.reduce((sum, value) => sum + value, 0) / values.length) *
                    1000,
                ) / 1000,
        };
      });

      return {
        conceptId,
        conceptName: context.get(conceptId)?.name ?? "A concept",
        perClass,
        comparable: perClass.filter((row) => row.meanEstimate !== null).length,
      };
    })
    // Concepts that can actually be compared first, then weakest. A row where
    // one class has a number and the rest do not is not a comparison, and it
    // should not lead a page about comparison.
    .sort((a, b) => {
      if (a.comparable !== b.comparable) return b.comparable - a.comparable;
      const left = Math.min(
        ...a.perClass.map((row) => row.meanEstimate ?? 1),
      );
      const right = Math.min(
        ...b.perClass.map((row) => row.meanEstimate ?? 1),
      );
      return left - right;
    });
}

export { MIN_MEASURED };
