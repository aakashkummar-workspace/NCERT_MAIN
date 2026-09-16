import "server-only";
import { withTenant } from "@/db/tenant";
import { conceptContext } from "@/core/curriculum/concepts";
import { bandFor, type Band } from "@/core/mastery/estimate";

/**
 * An estimate as a whole percentage that cannot contradict its band.
 *
 * Rounded, 0.595 prints as 60 — in the "needs practice" colour, beside a legend
 * that puts 60 in "almost there". The band boundaries sit on whole percentages
 * (0.4, 0.6, 0.8), so FLOORING keeps the printed number on the same side of
 * every boundary as the estimate itself. It goes through the thousandths first
 * because the stored value is decimal(4,3): 0.58 * 100 is 57.99999999999999 in
 * floating point, and a bare floor would print 57.
 */
export function displayPercent(estimate: number): number {
  return Math.floor(Math.round(estimate * 1000) / 10);
}

/**
 * What a class knows.
 *
 * ---------------------------------------------------------------------------
 * The refusal has to survive aggregation, and that is the hard part
 * ---------------------------------------------------------------------------
 * `core/mastery` refuses to give a number for a student with too little
 * evidence. Averaging is exactly where that refusal gets quietly undone: take
 * twenty-four students, find that three have enough evidence, average those
 * three, and print it as "the class". The number is arithmetically correct and
 * the claim is false.
 *
 * So every figure here reports the denominator it was computed over, and below
 * MIN_MEASURED students there is no figure at all — the same shape as the
 * per-student refusal and the same shape as `MIN_TO_SUMMARISE` on the results
 * page. A teacher deciding whether to reteach a chapter needs to know they are
 * looking at three students, not twenty-four.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately not here
 * ---------------------------------------------------------------------------
 * A single "class mastery" score. Averaging across concepts produces a number
 * that moves when the syllabus moves and means nothing on its own — and it is
 * precisely the number that would get printed on a report and compared between
 * teachers.
 */

/**
 * Fewer measured students than this and a concept reports no class figure.
 *
 * Three is not a statistical threshold. It is the point below which the number
 * describes which students happened to sit the last paper rather than the
 * class.
 */
export const MIN_MEASURED = 3;

export type ConceptRow = {
  conceptId: string;
  conceptName: string;
  chapters: string[];
  /** Students with enough evidence for an estimate of their own. */
  measured: number;
  /** Students on the roster, measured or not. */
  total: number;
  counts: Record<Band, number>;
  /** Null below MIN_MEASURED — see the note above. */
  meanEstimate: number | null;
  /** The band that mean falls in, or null alongside it. */
  band: Band | null;
  /** Students in CRITICAL or FRAGILE, among those measured. */
  struggling: number;
  needsAttention: boolean;
};

export type StudentRow = {
  studentUserId: string;
  fullName: string;
  /** One cell per concept, in the same order as `concepts`. */
  cells: { conceptId: string; band: Band; estimate: number | null }[];
  measured: number;
};

export type ClassOverview = {
  classId: string;
  className: string;
  subjectName: string;
  students: number;
  /** Concepts anyone in this class has evidence on. */
  concepts: ConceptRow[];
  rows: StudentRow[];
  /** Students with no evidence at all — they have not sat anything marked. */
  unmeasuredStudents: number;
};

const EMPTY_COUNTS = (): Record<Band, number> => ({
  CRITICAL: 0,
  FRAGILE: 0,
  DEVELOPING: 0,
  SECURE: 0,
  INSUFFICIENT: 0,
});

export async function classOverview(
  organizationId: string,
  classId: string,
): Promise<ClassOverview | null> {
  const data = await withTenant(organizationId, async (tx) => {
    const klass = await tx.class.findFirst({
      where: { id: classId, deletedAt: null },
      include: { subject: { select: { name: true } } },
    });
    if (!klass) return null;

    const enrolments = await tx.classEnrolment.findMany({
      where: { classId, status: "ACTIVE" },
      select: { studentUserId: true },
    });
    const studentIds = enrolments.map((e) => e.studentUserId);
    if (studentIds.length === 0) {
      return { klass, students: [], mastery: [] };
    }

    const students = await tx.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
    });

    const mastery = await tx.studentConceptMastery.findMany({
      where: { studentUserId: { in: studentIds } },
    });

    return { klass, students, mastery };
  });

  if (!data) return null;
  const { klass, students, mastery } = data;

  const conceptIds = [...new Set(mastery.map((row) => row.conceptId))];
  const context = await conceptContext(conceptIds);

  // Ordered by name so the heatmap's columns do not move between page loads.
  // A grid whose columns reshuffle is a grid a teacher cannot compare.
  const ordered = conceptIds.sort((a, b) =>
    (context.get(a)?.name ?? "").localeCompare(context.get(b)?.name ?? ""),
  );

  const byStudent = new Map<string, Map<string, (typeof mastery)[number]>>();
  for (const row of mastery) {
    const forStudent = byStudent.get(row.studentUserId) ?? new Map();
    forStudent.set(row.conceptId, row);
    byStudent.set(row.studentUserId, forStudent);
  }

  const concepts: ConceptRow[] = ordered.map((conceptId) => {
    const counts = EMPTY_COUNTS();
    const estimates: number[] = [];

    for (const student of students) {
      const row = byStudent.get(student.id)?.get(conceptId);
      // A student with no row at all has not answered anything on this concept.
      // That is INSUFFICIENT for the same reason a student with two answers is:
      // nothing is known. Counting them as a low score would invent a finding.
      const band = (row?.band as Band | undefined) ?? "INSUFFICIENT";
      counts[band]++;
      if (row?.estimate !== null && row?.estimate !== undefined) {
        estimates.push(Number(row.estimate));
      }
    }

    const measured = estimates.length;
    const enough = measured >= MIN_MEASURED;
    const mean = enough
      ? Math.round((estimates.reduce((a, b) => a + b, 0) / measured) * 1000) / 1000
      : null;

    return {
      conceptId,
      conceptName: context.get(conceptId)?.name ?? "Unknown concept",
      chapters: context.get(conceptId)?.chapters ?? [],
      measured,
      total: students.length,
      counts,
      meanEstimate: mean,
      band: mean === null ? null : bandFor(mean),
      struggling: counts.CRITICAL + counts.FRAGILE,
      // Worth a lesson when most of the measured students are struggling — and
      // only when enough of them are measured for that to mean anything.
      needsAttention: enough && counts.CRITICAL + counts.FRAGILE > measured / 2,
    };
  });

  const rows: StudentRow[] = students.map((student) => {
    const cells = ordered.map((conceptId) => {
      const row = byStudent.get(student.id)?.get(conceptId);
      return {
        conceptId,
        band: (row?.band as Band | undefined) ?? "INSUFFICIENT",
        estimate:
          row?.estimate === null || row?.estimate === undefined
            ? null
            : Number(row.estimate),
      };
    });

    return {
      studentUserId: student.id,
      fullName: student.fullName,
      cells,
      measured: cells.filter((cell) => cell.estimate !== null).length,
    };
  });

  return {
    classId,
    className: klass.name,
    subjectName: klass.subject.name,
    students: students.length,
    concepts,
    rows,
    unmeasuredStudents: rows.filter((row) => row.measured === 0).length,
  };
}
