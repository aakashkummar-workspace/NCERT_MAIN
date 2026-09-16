import "server-only";
import { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { conceptContext } from "@/core/curriculum/concepts";
import { resultsVisible } from "@/core/assignments/window";
import { maskPhone } from "@/core/student/rules";
import { storedLetterhead, type Letterhead } from "@/core/branding";

/**
 * Everything a parent can see, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * This module is the boundary
 * ---------------------------------------------------------------------------
 * DOMAIN_MODEL.md: *"scope is read-only, restricted to performance data. Tutor
 * conversations, mistake-bank contents and free-text answers are outside it."*
 *
 * A rule like that, left as a sentence, survives about two features. So it is a
 * shape instead: parent routes may read student data through this file and no
 * other, and an ESLint fence stops `src/app/p/**` and `src/app/api/parent/**`
 * importing `core/mistakes`, `core/practice`, `core/results` or `core/attempts`
 * at all. Nothing here returns a free-text answer, and there is no argument
 * that could make it.
 *
 * The reason is not compliance theatre. A child who believes a parent reads
 * every question they ask stops asking questions — which costs the child the
 * help and the product the feature, in one move.
 *
 * ---------------------------------------------------------------------------
 * Access is the link, checked every time
 * ---------------------------------------------------------------------------
 * `linkedStudents()` is the only way to learn which children exist for a
 * parent, and every other function here takes its student id from that list
 * rather than from a caller. A route cannot pass a student id it was handed:
 * there is no function that accepts one without re-deriving the link.
 */

export type Actor = { organizationId: string; userId: string };

export type LinkedStudent = {
  studentUserId: string;
  fullName: string;
  relationship: string;
  className: string | null;
  linkedAt: Date;
};

/**
 * The children this parent has a live, consented link to.
 *
 * Three conditions, all required: the link exists, consent was granted, and it
 * has not been revoked. An invited-but-not-accepted link grants nothing, which
 * is what makes the invitation safe to send to a phone number.
 */
export async function linkedStudents(actor: Actor): Promise<LinkedStudent[]> {
  return withTenant(actor.organizationId, async (tx) => {
    const links = await tx.parentStudentLink.findMany({
      where: {
        parentUserId: actor.userId,
        consentGrantedAt: { not: null },
        revokedAt: null,
      },
      orderBy: { createdAt: "asc" },
    });
    if (links.length === 0) return [];

    const studentIds = links.map((link) => link.studentUserId);
    const [users, enrolments] = await Promise.all([
      tx.user.findMany({
        where: { id: { in: studentIds } },
        // Name only. A parent needs to know which child they are looking at;
        // they do not need the child's phone number from this screen, and a
        // field selected here is a field one refactor away from a payload.
        select: { id: true, fullName: true },
      }),
      tx.classEnrolment.findMany({
        where: { studentUserId: { in: studentIds }, status: "ACTIVE" },
        include: { class: { select: { name: true } } },
      }),
    ]);

    const nameById = new Map(users.map((user) => [user.id, user.fullName]));
    const classByStudent = new Map(
      enrolments.map((row) => [row.studentUserId, row.class.name]),
    );

    return links.map((link) => ({
      studentUserId: link.studentUserId,
      fullName: nameById.get(link.studentUserId) ?? "Your child",
      relationship: link.relationship,
      className: classByStudent.get(link.studentUserId) ?? null,
      linkedAt: link.consentGrantedAt!,
    }));
  });
}

/**
 * Re-derive the link for one child, or refuse.
 *
 * Every read below goes through this. A parent id and a student id arriving
 * together from a request prove nothing on their own, and this is the one place
 * that turns them into permission.
 */
async function permitted(
  actor: Actor,
  studentUserId: string,
): Promise<{ ok: true; scope: Record<string, unknown> } | { ok: false }> {
  // A malformed id is a child who is not theirs, not a 500 from Postgres.
  if (!isUuid(studentUserId)) return { ok: false };
  const link = await withTenant(actor.organizationId, (tx) =>
    tx.parentStudentLink.findFirst({
      where: {
        parentUserId: actor.userId,
        studentUserId,
        consentGrantedAt: { not: null },
        revokedAt: null,
      },
      select: { scope: true },
    }),
  );
  if (!link) return { ok: false };

  // The scope column is consulted rather than assumed. One key is honoured
  // today; a column nothing reads is a promise in a comment.
  const scope = (link.scope ?? {}) as Record<string, unknown>;
  if (scope.performance !== true) return { ok: false };

  return { ok: true, scope };
}

export type ConceptRow = {
  conceptId: string;
  conceptName: string;
  /** Null below the evidence threshold. The refusal reaches here intact. */
  estimate: number | null;
  band: string;
  trend: string | null;
};

export type SittingRow = {
  assignmentId: string;
  attemptId: string;
  title: string;
  subjectName: string;
  satAt: Date;
  /** Null until the teacher releases it. A parent never front-runs the child. */
  percentage: number | null;
  /**
   * Null until released, and ALSO null while nobody has scored anything.
   *
   * `awarded` is what has been decided so far, not a final mark, and
   * `awaitingMarking` is the marks a teacher still has to give. Null is not
   * zero: a paper with a written answer nobody has read is "marked so far",
   * never "0 / 5" — which a parent reads as their child having failed.
   */
  marks: {
    /** Null when nothing on the paper has been scored at all. */
    awarded: number | null;
    total: number;
    awaitingMarking: number;
  } | null;
  /** True once released with nothing left to mark. */
  fullyMarked: boolean;
};

export type ChildView = {
  studentUserId: string;
  fullName: string;
  className: string | null;
  /** Concepts with a real estimate. The denominator for everything below. */
  measured: number;
  secure: number;
  needsWork: number;
  /** Strongest and weakest by name — never a single overall score. */
  strengths: ConceptRow[];
  attention: ConceptRow[];
  sittings: SittingRow[];
  /**
   * A sentence, or null when there is not enough to say one.
   *
   * The same refusal the teacher's analytics makes, for a harder audience: a
   * parent handed a confident paragraph about three marked questions will make
   * a decision on it.
   */
  summary: string | null;
};

/** Below this there is no honest summary to write. Same bar as the class read. */
export const MIN_MEASURED = 3;

export async function childView(
  actor: Actor,
  studentUserId: string,
): Promise<ChildView | null> {
  const allowed = await permitted(actor, studentUserId);
  if (!allowed.ok) return null;

  const data = await withTenant(actor.organizationId, async (tx) => {
    const [user, enrolment, mastery, attempts] = await Promise.all([
      tx.user.findFirst({
        where: { id: studentUserId },
        select: { id: true, fullName: true },
      }),
      tx.classEnrolment.findFirst({
        where: { studentUserId, status: "ACTIVE" },
        include: { class: { select: { name: true } } },
      }),
      tx.studentConceptMastery.findMany({ where: { studentUserId } }),
      tx.attempt.findMany({
        where: { studentUserId, status: { not: "IN_PROGRESS" } },
        orderBy: { submittedAt: "desc" },
        take: 20,
        // Deliberately NOT including `answers`. There is no shape of this
        // query that returns what the child wrote.
        select: {
          id: true,
          assignmentId: true,
          submittedAt: true,
          startedAt: true,
          rawScore: true,
          maxScore: true,
          percentage: true,
        },
      }),
    ]);
    if (!user) return null;

    const assignments = await tx.assignment.findMany({
      where: { id: { in: attempts.map((a) => a.assignmentId) } },
      include: {
        assessment: {
          select: { title: true, subject: { select: { name: true } } },
        },
      },
    });

    // The marks still with the teacher, per paper. What is READ is an
    // answer's max marks and whether it has a mark — the response is only
    // filtered on, never selected, so nothing the child wrote leaves this
    // query. A blank objective answer is settled, not pending.
    const pending =
      attempts.length === 0
        ? []
        : await tx.attemptAnswer.groupBy({
            by: ["attemptId"],
            where: {
              attemptId: { in: attempts.map((attempt) => attempt.id) },
              awardedMarks: null,
              response: { not: Prisma.DbNull },
            },
            _sum: { maxMarks: true },
          });

    return { user, enrolment, mastery, attempts, assignments, pending };
  });
  if (!data) return null;

  const { user, enrolment, mastery, attempts, assignments } = data;
  const pendingBy = new Map(
    data.pending.map((row) => [row.attemptId, Number(row._sum.maxMarks ?? 0)]),
  );

  const context = await conceptContext(mastery.map((row) => row.conceptId));
  const rows: ConceptRow[] = mastery.map((row) => ({
    conceptId: row.conceptId,
    conceptName: context.get(row.conceptId)?.name ?? "A concept",
    estimate: row.estimate === null ? null : Number(row.estimate),
    band: row.band,
    trend: row.trend,
  }));

  const measured = rows.filter((row) => row.estimate !== null);
  const secure = measured.filter((row) => row.band === "SECURE");
  const needsWork = measured.filter(
    (row) => row.band === "CRITICAL" || row.band === "FRAGILE",
  );

  // Strengths exclude anything that needs help. Without that, a child with one
  // measured concept had it listed under BOTH headings — "Where the help would
  // go" and "Going well" — carrying the same "Needs help" badge in each. A
  // screenshot caught it; a parent would have read it as the product not
  // knowing what it was talking about, and been right.
  const needsWorkIds = new Set(needsWork.map((row) => row.conceptId));
  const byStrength = measured
    .filter((row) => !needsWorkIds.has(row.conceptId))
    .sort((a, b) => (b.estimate ?? 0) - (a.estimate ?? 0));

  const assignmentById = new Map(assignments.map((a) => [a.id, a]));

  return {
    studentUserId: user.id,
    fullName: user.fullName,
    className: enrolment?.class.name ?? null,
    measured: measured.length,
    secure: secure.length,
    needsWork: needsWork.length,
    strengths: byStrength.slice(0, 3),
    attention: [...needsWork]
      .sort((a, b) => (a.estimate ?? 0) - (b.estimate ?? 0))
      .slice(0, 3),
    sittings: attempts.map((attempt) => {
      const assignment = assignmentById.get(attempt.assignmentId);
      // The teacher's release policy governs a parent exactly as it governs the
      // student, through the same function. A parent seeing a mark before their
      // child does turns a result into an ambush.
      const released = assignment !== undefined && resultsVisible(assignment);
      const awaiting = pendingBy.get(attempt.id) ?? 0;

      return {
        assignmentId: attempt.assignmentId,
        attemptId: attempt.id,
        title: assignment?.assessment.title ?? "A test",
        subjectName: assignment?.assessment.subject.name ?? "",
        satAt: attempt.submittedAt ?? attempt.startedAt,
        // A percentage over a half-marked paper is a wrong figure, not a
        // smaller one — so it waits for the marking, as on the child's page.
        percentage:
          released && awaiting === 0 && attempt.percentage !== null
            ? Number(attempt.percentage)
            : null,
        marks:
          released && attempt.maxScore !== null
            ? {
                awarded: attempt.rawScore === null ? null : Number(attempt.rawScore),
                total: Number(attempt.maxScore),
                awaitingMarking: awaiting,
              }
            : null,
        fullyMarked: released && awaiting === 0 && attempt.rawScore !== null,
      };
    }),
    summary: summarise(user.fullName, measured.length, secure, needsWork),
  };
}

/**
 * The plain-language sentence, or nothing.
 *
 * Written as a function of the counts rather than generated, and it refuses
 * below the threshold. A parent is the audience least equipped to discount a
 * confident paragraph and most likely to act on one, so the bar for saying
 * anything at all is the same as the teacher's and the consequence of clearing
 * it is a sentence with the denominator in it.
 */
function summarise(
  fullName: string,
  measured: number,
  secure: ConceptRow[],
  needsWork: ConceptRow[],
): string | null {
  if (measured < MIN_MEASURED) return null;

  const firstName = fullName.split(/\s+/)[0] ?? fullName;

  if (needsWork.length === 0) {
    return `Across the ${measured} topics measured so far, ${firstName} is doing well — nothing is currently marked as needing attention.`;
  }

  const names = needsWork
    .slice(0, 2)
    .map((row) => row.conceptName)
    .join(" and ");

  if (secure.length === 0) {
    return `Of the ${measured} topics measured so far, ${needsWork.length} need attention — ${names} most of all. This is based on work marked so far, not on the whole year.`;
  }

  return `Of the ${measured} topics measured so far, ${firstName} is secure on ${secure.length} and needs attention on ${needsWork.length} — ${names} most of all.`;
}

export type ProgressPoint = {
  conceptId: string;
  conceptName: string;
  estimate: number;
  previous: number | null;
  trend: string | null;
};

/**
 * Improvement over time, per concept.
 *
 * Per concept and never as one line: an average across concepts moves when the
 * syllabus moves, and it is exactly the figure a parent would compare with
 * another parent's child.
 */
export async function childProgress(
  actor: Actor,
  studentUserId: string,
): Promise<ProgressPoint[] | null> {
  const allowed = await permitted(actor, studentUserId);
  if (!allowed.ok) return null;

  const mastery = await withTenant(actor.organizationId, (tx) =>
    tx.studentConceptMastery.findMany({
      where: { studentUserId, estimate: { not: null } },
    }),
  );
  if (mastery.length === 0) return [];

  const context = await conceptContext(mastery.map((row) => row.conceptId));

  return mastery
    .map((row) => ({
      conceptId: row.conceptId,
      conceptName: context.get(row.conceptId)?.name ?? "A concept",
      estimate: Number(row.estimate),
      previous:
        row.previousEstimate === null ? null : Number(row.previousEstimate),
      trend: row.trend,
    }))
    .sort((a, b) => a.estimate - b.estimate);
}

// ---------------------------------------------------------------------------
// The other direction: who can see ME
// ---------------------------------------------------------------------------

export type ProgressViewer = {
  relationship: string;
  /** "98•••••210", or null when no usable number is on file. Never the number. */
  phoneHint: string | null;
  /**
   * ACTIVE can see performance data now. INVITED can see nothing until the
   * person holding that phone accepts — listed anyway, because a student who
   * is only told once it is live has been told too late to ask about it.
   */
  status: "ACTIVE" | "INVITED";
  since: Date;
};

/**
 * The guardians who can see this student's progress, for the STUDENT.
 *
 * Here rather than in `link.ts` because this file is the boundary for what a
 * parent can see, and "who is on the other side of that boundary" is the same
 * fact read from the child's end. The actor IS the student: the query is keyed
 * on `actor.userId` and there is no argument naming anybody else, so a route
 * cannot turn it into a lookup of another child's family.
 *
 * What it does not return is as deliberate as what it does. No parent's name
 * (the relationship is what a student recognises), no full phone number, no
 * revoked links, and no expired invitations — an invitation nobody can accept
 * any more is not somebody who might be able to see anything.
 */
export async function whoCanSeeMyProgress(
  actor: Actor,
  now = new Date(),
): Promise<ProgressViewer[]> {
  return withTenant(actor.organizationId, async (tx) => {
    const [links, invitations] = await Promise.all([
      tx.parentStudentLink.findMany({
        where: {
          studentUserId: actor.userId,
          consentGrantedAt: { not: null },
          revokedAt: null,
        },
        orderBy: { consentGrantedAt: "asc" },
        select: {
          parentUserId: true,
          relationship: true,
          consentGrantedAt: true,
          scope: true,
        },
      }),
      tx.invitation.findMany({
        where: {
          studentUserId: actor.userId,
          role: "PARENT",
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: "asc" },
        select: { relationship: true, phone: true, createdAt: true },
      }),
    ]);

    // Only links whose scope actually grants something, by the same test
    // `permitted()` applies. Telling a student somebody can see their progress
    // when the link grants nothing would be a false alarm about their privacy.
    const live = links.filter(
      (link) => ((link.scope ?? {}) as Record<string, unknown>).performance === true,
    );

    const parents =
      live.length === 0
        ? []
        : await tx.user.findMany({
            where: { id: { in: live.map((link) => link.parentUserId) } },
            select: { id: true, phone: true },
          });
    const phoneById = new Map(parents.map((user) => [user.id, user.phone]));

    return [
      ...live.map((link) => ({
        relationship: link.relationship,
        phoneHint: maskPhone(phoneById.get(link.parentUserId)),
        status: "ACTIVE" as const,
        since: link.consentGrantedAt!,
      })),
      ...invitations.map((invitation) => ({
        relationship: invitation.relationship ?? "GUARDIAN",
        phoneHint: maskPhone(invitation.phone),
        status: "INVITED" as const,
        since: invitation.createdAt,
      })),
    ];
  });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * The term reports written about this child.
 *
 * Reports reach a parent through this door and no other, like everything else
 * here. The consent check runs first and the payload is returned as stored —
 * never rebuilt, because the whole point of a report is that the sheet a parent
 * was handed in September still says in December what it said in September.
 *
 * Nothing is filtered on the way out, and that is safe by construction rather
 * than by care here: `core/reports/build.ts` puts no free text, no per-question
 * detail and no answer of the child's into a payload in the first place. A
 * report is already written for this audience.
 */
export type ParentReportRow = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  /** True for every report but the newest. The older ones stay readable. */
  superseded: boolean;
};

export async function childReports(
  actor: Actor,
  studentUserId: string,
): Promise<ParentReportRow[]> {
  const allowed = await permitted(actor, studentUserId);
  if (!allowed.ok) return [];

  const reports = await withTenant(actor.organizationId, (tx) =>
    tx.report.findMany({
      where: { studentUserId },
      orderBy: { generatedAt: "desc" },
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        generatedAt: true,
      },
      take: 50,
    }),
  );

  return reports.map((report, index) => ({ ...report, superseded: index > 0 }));
}

export type ParentReport = ParentReportRow & {
  studentUserId: string;
  payloadVersion: number;
  payload: unknown;
  /** The school's letterhead as stamped on the day. */
  letterhead: Letterhead | null;
};

export async function childReport(
  actor: Actor,
  reportId: string,
): Promise<ParentReport | null> {
  if (!isUuid(reportId)) return null;
  const report = await withTenant(actor.organizationId, (tx) =>
    tx.report.findFirst({ where: { id: reportId } }),
  );
  if (!report) return null;

  // The consent check is on the CHILD the report is about, resolved from the
  // row rather than taken from the caller. A reportId is not a capability.
  const allowed = await permitted(actor, report.studentUserId);
  if (!allowed.ok) return null;

  const newest = await withTenant(actor.organizationId, (tx) =>
    tx.report.findFirst({
      where: { studentUserId: report.studentUserId },
      orderBy: { generatedAt: "desc" },
      select: { id: true },
    }),
  );

  return {
    id: report.id,
    studentUserId: report.studentUserId,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    generatedAt: report.generatedAt,
    superseded: newest?.id !== report.id,
    payloadVersion: report.payloadVersion,
    payload: report.payload,
    letterhead: storedLetterhead(report.letterhead),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id names nothing, and must reach a 404 rather than Postgres. */
function isUuid(value: string): boolean {
  return UUID.test(value);
}
