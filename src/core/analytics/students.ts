import "server-only";
import { withTenant } from "@/db/tenant";

/**
 * Every student in the organization, in one list.
 *
 * The class pages answer "how is 10-A doing". This answers the other question a
 * teacher with four classes actually has: "who, anywhere, is in trouble".
 *
 * ---------------------------------------------------------------------------
 * What it deliberately does not do
 * ---------------------------------------------------------------------------
 * There is no overall score per student. Averaging a student's mastery across
 * every concept produces a single number that moves when the syllabus moves,
 * invites ranking a class by it, and hides the thing that matters — which
 * concept. So the list carries counts by band and the weakest concept by name,
 * and a teacher who wants a ranking has to decide for themselves what to rank
 * by.
 */

export type StudentRow = {
  studentUserId: string;
  fullName: string;
  classNames: string[];
  /** Whether they can receive a sign-in code at all. */
  canSignIn: boolean;
  sittings: number;
  /** Concepts with a real estimate. The denominator for everything below. */
  measuredConcepts: number;
  struggling: number;
  secure: number;
  /** The concept they are weakest on, when there is enough to say. */
  weakest: { conceptId: string; estimate: number } | null;
  lastSatAt: Date | null;
};

export async function listStudents(
  organizationId: string,
): Promise<StudentRow[]> {
  return withTenant(organizationId, async (tx) => {
    const memberships = await tx.membership.findMany({
      where: { role: "STUDENT", status: "ACTIVE" },
      select: { userId: true },
    });
    const studentIds = memberships.map((membership) => membership.userId);
    if (studentIds.length === 0) return [];

    const [users, enrolments, mastery, attempts] = await Promise.all([
      tx.user.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, fullName: true, phone: true },
        orderBy: { fullName: "asc" },
      }),
      tx.classEnrolment.findMany({
        where: { studentUserId: { in: studentIds }, status: "ACTIVE" },
        include: { class: { select: { name: true } } },
      }),
      tx.studentConceptMastery.findMany({
        where: { studentUserId: { in: studentIds } },
      }),
      tx.attempt.findMany({
        where: { studentUserId: { in: studentIds }, status: { not: "IN_PROGRESS" } },
        select: { studentUserId: true, submittedAt: true },
      }),
    ]);

    const classesByStudent = new Map<string, string[]>();
    for (const enrolment of enrolments) {
      const list = classesByStudent.get(enrolment.studentUserId) ?? [];
      list.push(enrolment.class.name);
      classesByStudent.set(enrolment.studentUserId, list);
    }

    const masteryByStudent = new Map<string, typeof mastery>();
    for (const row of mastery) {
      const list = masteryByStudent.get(row.studentUserId) ?? [];
      list.push(row);
      masteryByStudent.set(row.studentUserId, list);
    }

    const sittingsByStudent = new Map<string, { count: number; last: Date | null }>();
    for (const attempt of attempts) {
      const entry = sittingsByStudent.get(attempt.studentUserId) ?? {
        count: 0,
        last: null,
      };
      entry.count++;
      if (
        attempt.submittedAt &&
        (entry.last === null || attempt.submittedAt > entry.last)
      ) {
        entry.last = attempt.submittedAt;
      }
      sittingsByStudent.set(attempt.studentUserId, entry);
    }

    return users.map((user) => {
      const rows = masteryByStudent.get(user.id) ?? [];
      const measured = rows.filter((row) => row.estimate !== null);

      const weakest = measured.reduce<{ conceptId: string; estimate: number } | null>(
        (worst, row) => {
          const estimate = Number(row.estimate);
          return worst === null || estimate < worst.estimate
            ? { conceptId: row.conceptId, estimate }
            : worst;
        },
        null,
      );

      const sittings = sittingsByStudent.get(user.id);

      return {
        studentUserId: user.id,
        fullName: user.fullName,
        classNames: classesByStudent.get(user.id) ?? [],
        // Surfaced here as well as on the class page. A student with no number
        // cannot sit anything, and discovering that on exam day is the failure
        // this keeps catching.
        canSignIn: Boolean(user.phone),
        sittings: sittings?.count ?? 0,
        measuredConcepts: measured.length,
        struggling: measured.filter(
          (row) => row.band === "CRITICAL" || row.band === "FRAGILE",
        ).length,
        secure: measured.filter((row) => row.band === "SECURE").length,
        weakest,
        lastSatAt: sittings?.last ?? null,
      };
    });
  });
}
