import "server-only";
import { withTenant } from "@/db/tenant";
import { studentMastery, type ConceptMastery } from "@/core/mastery/read";

/**
 * One student, as a teacher reads them.
 *
 * Deliberately two things side by side: what they scored, and what we believe
 * they know. They are different claims and the product refuses to conflate them
 * anywhere else, so it must not start here — a run of good scores on easy
 * papers is not mastery, and one bad afternoon is not a gap.
 *
 * The sittings are listed because mastery without the events behind it is a
 * number a teacher cannot argue with. "Fragile on similar triangles" invites
 * "since when?", and the answer has to be on the same screen.
 */

/** Readings from fewer sittings than this carry no trend. */
export const MIN_SITTINGS_FOR_TREND = 2;

export type Sitting = {
  attemptId: string;
  assignmentId: string;
  title: string;
  submittedAt: Date | null;
  rawScore: number | null;
  maxScore: number | null;
  percentage: number | null;
  /** Marks still with a teacher. A score with these outstanding is partial. */
  pendingMarks: number;
};

export type StudentProfile = {
  studentUserId: string;
  fullName: string;
  classNames: string[];
  sittings: Sitting[];
  mastery: ConceptMastery[];
  /** Concepts with a real estimate — the denominator for anything said below. */
  measuredConcepts: number;
};

export async function studentProfile(
  organizationId: string,
  studentUserId: string,
): Promise<StudentProfile | null> {
  const base = await withTenant(organizationId, async (tx) => {
    // Membership, not the users table alone: a user row is global, and being
    // able to name somebody is not the same as them being your student.
    const membership = await tx.membership.findFirst({
      where: { userId: studentUserId, role: "STUDENT", status: "ACTIVE" },
    });
    if (!membership) return null;

    const user = await tx.user.findFirst({
      where: { id: studentUserId },
      select: { id: true, fullName: true },
    });
    if (!user) return null;

    const enrolments = await tx.classEnrolment.findMany({
      where: { studentUserId, status: "ACTIVE" },
      include: { class: { select: { name: true } } },
    });

    const attempts = await tx.attempt.findMany({
      where: { studentUserId, status: { not: "IN_PROGRESS" } },
      include: {
        assignment: { include: { assessment: { select: { title: true } } } },
        answers: { select: { awardedMarks: true, maxMarks: true, response: true } },
      },
      orderBy: { submittedAt: "desc" },
      take: 20,
    });

    // Which sitting each piece of evidence came from, per concept. See the note
    // on `trend` below.
    const evidence = await tx.conceptEvidence.findMany({
      where: { studentUserId },
      select: { conceptId: true, attemptAnswerId: true, practiceAnswerId: true },
    });
    const attemptAnswerIds = evidence.flatMap((row) =>
      row.attemptAnswerId ? [row.attemptAnswerId] : [],
    );
    const practiceAnswerIds = evidence.flatMap((row) =>
      row.practiceAnswerId ? [row.practiceAnswerId] : [],
    );
    const [attemptAnswers, practiceAnswers] = await Promise.all([
      attemptAnswerIds.length === 0
        ? []
        : tx.attemptAnswer.findMany({
            where: { id: { in: attemptAnswerIds } },
            select: { id: true, attemptId: true },
          }),
      practiceAnswerIds.length === 0
        ? []
        : tx.practiceAnswer.findMany({
            where: { id: { in: practiceAnswerIds } },
            select: { id: true, practiceSessionId: true },
          }),
    ]);
    const sittingOfAnswer = new Map<string, string>([
      ...attemptAnswers.map((row) => [row.id, `attempt:${row.attemptId}`] as [string, string]),
      ...practiceAnswers.map(
        (row) => [row.id, `practice:${row.practiceSessionId}`] as [string, string],
      ),
    ]);
    const sittingsByConcept = new Map<string, Set<string>>();
    for (const row of evidence) {
      const answerId = row.attemptAnswerId ?? row.practiceAnswerId;
      const sitting = answerId ? sittingOfAnswer.get(answerId) : undefined;
      if (!sitting) continue;
      const set = sittingsByConcept.get(row.conceptId) ?? new Set<string>();
      set.add(sitting);
      sittingsByConcept.set(row.conceptId, set);
    }

    return {
      user,
      sittingsByConcept,
      classNames: enrolments.map((e) => e.class.name),
      sittings: attempts.map((attempt) => ({
        attemptId: attempt.id,
        assignmentId: attempt.assignmentId,
        title: attempt.assignment.assessment.title,
        submittedAt: attempt.submittedAt,
        rawScore: attempt.rawScore === null ? null : Number(attempt.rawScore),
        maxScore: attempt.maxScore === null ? null : Number(attempt.maxScore),
        percentage: attempt.percentage === null ? null : Number(attempt.percentage),
        pendingMarks: attempt.answers.reduce(
          (sum, answer) =>
            answer.awardedMarks === null && answer.response !== null
              ? sum + Number(answer.maxMarks)
              : sum,
          0,
        ),
      })),
    };
  });

  if (!base) return null;

  // A trend is movement between readings, and readings come from sittings. The
  // stored trend compares the estimate before and after the last write, and
  // one paper writes its answers in turn — so a concept measured in a single
  // sitting on a single day showed "Improving" or "Holding steady", a claim
  // about change over time made from one afternoon. Below two sittings there
  // is no trend to show, and the component shows nothing for UNKNOWN.
  const mastery = (await studentMastery(organizationId, studentUserId)).map((row) =>
    (base.sittingsByConcept.get(row.conceptId)?.size ?? 0) >= MIN_SITTINGS_FOR_TREND
      ? row
      : { ...row, trend: "UNKNOWN" as const },
  );

  return {
    studentUserId: base.user.id,
    fullName: base.user.fullName,
    classNames: base.classNames,
    sittings: base.sittings,
    mastery,
    measuredConcepts: mastery.filter((row) => row.estimate !== null).length,
  };
}
