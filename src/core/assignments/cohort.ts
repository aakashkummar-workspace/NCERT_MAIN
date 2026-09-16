import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Who is expected to sit an assignment.
 *
 * One function, because the rule has to mean the same thing in three places:
 * the assignment page, the results page, and the marking queue. "No target rows
 * means the whole class, including anyone who joins tomorrow" is easy to write
 * correctly once and easy to get subtly wrong the second and third time — and a
 * results page that disagrees with the assignment page about who was expected
 * produces a class average over the wrong denominator.
 */
export async function expectedStudentIds(
  tx: Prisma.TransactionClient,
  assignment: { classId: string; targets: { studentUserId: string }[] },
): Promise<string[]> {
  const enrolments = await tx.classEnrolment.findMany({
    where: { classId: assignment.classId, status: "ACTIVE" },
    select: { studentUserId: true },
  });

  const targeted = new Set(assignment.targets.map((t) => t.studentUserId));
  if (targeted.size === 0) return enrolments.map((e) => e.studentUserId);

  // Intersected with the live roster, not taken from the target rows alone: a
  // student named in the target list who has since left the class is no longer
  // expected, and counting them keeps a class permanently short of 100%.
  return enrolments
    .map((e) => e.studentUserId)
    .filter((id) => targeted.has(id));
}
