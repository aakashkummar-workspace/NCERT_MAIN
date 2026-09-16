import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { can } from "@/core/billing/entitlements";
import { conceptsForSubjects } from "@/core/curriculum/concepts";
import { estimateMastery, type Evidence } from "@/core/mastery/estimate";
import { resultsVisible } from "@/core/assignments/window";
import { letterheadFor, storedLetterhead, type Letterhead } from "@/core/branding";
import {
  buildReport,
  type ReportConcept,
  type ReportPayload,
  type ReportSitting,
} from "./build";

/**
 * Generating and reading reports.
 *
 * ---------------------------------------------------------------------------
 * The payload is written once and never recomputed
 * ---------------------------------------------------------------------------
 * Same invariant as an intervention's baseline, and the same reason: a parent
 * shown "62% across 4 of 9 ideas" at a September meeting must be able to bring
 * that sheet in December and have it still say that. A report regenerated on
 * read would change silently under a conversation.
 *
 * So there is no update path. Generating again for the same student SUPERSEDES
 * — a new row, newest first — and the old one stays, because "what did we tell
 * this parent in September" is a question somebody asks.
 *
 * ---------------------------------------------------------------------------
 * The opening estimate is the ledger's whole purpose, finally used
 * ---------------------------------------------------------------------------
 * `concept_evidence` is an append-only record and
 * `student_concept_mastery` is a belief derived from it, and the stated reason
 * for the split has always been that *every past estimate must be
 * re-derivable*. Improvement over a term is the first feature that actually
 * needs that: it runs the same pure estimator over the same rows, filtered to
 * what was known on the day the period opened.
 *
 * There is no stored history table and there does not need to be one.
 */

export type Actor = { organizationId: string; userId: string };

/** The shape `payload` is in. Bump when the payload changes shape. */
export const PAYLOAD_VERSION = 1;

export type GenerateResult =
  | { ok: true; reportId: string; payload: ReportPayload }
  | { ok: false; reason: "not-entitled" | "not-found" | "not-enough-measured"; message: string };

export async function generateReport(
  actor: Actor,
  input: {
    studentUserId: string;
    classId?: string | null;
    periodStart: Date;
    periodEnd: Date;
  },
  now = new Date(),
): Promise<GenerateResult> {
  // The plan before the data, as everywhere else: "your plan does not include
  // reports" and "there is not enough measured" are different facts, and a
  // teacher on Free should hear the first.
  const entitled = await can(actor.organizationId, "parent_reports", now);
  if (!entitled.allowed) {
    return {
      ok: false,
      reason: "not-entitled",
      message: "Reports are not part of your plan yet.",
    };
  }

  const gathered = await gather(actor, input);
  if (!gathered) {
    return { ok: false, reason: "not-found", message: "We could not find that student." };
  }

  const built = buildReport(gathered);
  if (!built.ok) {
    // Refused rather than generated thin. A document with a date on it will be
    // acted on, and a thin one is worse than none.
    return { ok: false, reason: built.reason, message: built.message };
  }

  // The letterhead is stamped with the payload and for the same reason: a sheet
  // written under one principal, with one address, must still say so when it
  // is reprinted after both have changed. Null for an unbranded school, which
  // renders exactly as reports always have.
  const letterhead = await letterheadFor(actor.organizationId);

  const reportId = await withTenant(actor.organizationId, async (tx) => {
    const id = randomUUID();
    await tx.report.createMany({
      data: [
        {
          id,
          organizationId: actor.organizationId,
          studentUserId: input.studentUserId,
          classId: input.classId ?? null,
          kind: "TERM",
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          generatedById: actor.userId,
          generatedAt: now,
          payload: built.payload as unknown as object,
          payloadVersion: PAYLOAD_VERSION,
          ...(letterhead ? { letterhead: letterhead as unknown as object } : {}),
        },
      ],
    });
    return id;
  });

  return { ok: true, reportId, payload: built.payload };
}

export type ClassRunRow = {
  studentUserId: string;
  fullName: string;
  reportId: string | null;
  /** Why this one was not generated. Named per student, never swallowed. */
  skipped: string | null;
};

/**
 * A report for every student in a class.
 *
 * The actual workflow: a teacher does not generate one report, they do a class
 * before parents' evening. Per-student refusals are REPORTED rather than
 * skipped silently — a teacher who gets 26 reports for a class of 30 needs to
 * know which four and why, before somebody's parent asks.
 */
export async function generateForClass(
  actor: Actor,
  input: { classId: string; periodStart: Date; periodEnd: Date },
  now = new Date(),
): Promise<{ ok: true; rows: ClassRunRow[] } | { ok: false; message: string }> {
  const entitled = await can(actor.organizationId, "parent_reports", now);
  if (!entitled.allowed) {
    return { ok: false, message: "Reports are not part of your plan yet." };
  }

  const students = await withTenant(actor.organizationId, async (tx) => {
    const klass = await tx.class.findFirst({ where: { id: input.classId } });
    if (!klass) return null;
    const enrolments = await tx.classEnrolment.findMany({
      where: { classId: input.classId, status: "ACTIVE" },
      select: { studentUserId: true },
    });
    const users = await tx.user.findMany({
      where: { id: { in: enrolments.map((e) => e.studentUserId) } },
      select: { id: true, fullName: true },
    });
    return users.sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

  if (!students) return { ok: false, message: "We could not find that class." };

  const rows: ClassRunRow[] = [];
  for (const student of students) {
    const result = await generateReport(
      actor,
      {
        studentUserId: student.id,
        classId: input.classId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      },
      now,
    );
    rows.push({
      studentUserId: student.id,
      fullName: student.fullName,
      reportId: result.ok ? result.reportId : null,
      skipped: result.ok ? null : result.message,
    });
  }

  return { ok: true, rows };
}

export type ReportRow = {
  id: string;
  studentUserId: string;
  studentName: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  /** True for every row but the newest for this student. */
  superseded: boolean;
};

export async function listReports(
  actor: Actor,
  filter: { studentUserId?: string; classId?: string } = {},
): Promise<ReportRow[]> {
  return withTenant(actor.organizationId, async (tx) => {
    const reports = await tx.report.findMany({
      where: {
        ...(filter.studentUserId ? { studentUserId: filter.studentUserId } : {}),
        ...(filter.classId ? { classId: filter.classId } : {}),
      },
      orderBy: { generatedAt: "desc" },
      take: 200,
    });
    if (reports.length === 0) return [];

    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(reports.map((r) => r.studentUserId))] } },
      select: { id: true, fullName: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));

    // Newest per student is current; everything older is superseded and says
    // so. A list that showed four reports for one child with no ordering
    // information is a list a teacher hands the wrong sheet from.
    const seen = new Set<string>();
    return reports.map((report) => {
      const superseded = seen.has(report.studentUserId);
      seen.add(report.studentUserId);
      return {
        id: report.id,
        studentUserId: report.studentUserId,
        studentName: nameById.get(report.studentUserId) ?? "This student",
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        generatedAt: report.generatedAt,
        superseded,
      };
    });
  });
}

export type StoredReport = {
  id: string;
  studentUserId: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  payloadVersion: number;
  payload: ReportPayload;
  /** As stamped when the report was written; null when the school was unbranded. */
  letterhead: Letterhead | null;
};

export async function getReport(
  actor: Actor,
  id: string,
): Promise<StoredReport | null> {
  const report = await withTenant(actor.organizationId, (tx) =>
    tx.report.findFirst({ where: { id } }),
  );
  if (!report) return null;
  return toStored(report);
}

/** Shared with the parent reader, which reaches reports through its own door. */
export function toStored(report: {
  id: string;
  studentUserId: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  payloadVersion: number;
  payload: unknown;
  letterhead?: unknown;
}): StoredReport {
  return {
    id: report.id,
    studentUserId: report.studentUserId,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    generatedAt: report.generatedAt,
    payloadVersion: report.payloadVersion,
    payload: report.payload as ReportPayload,
    letterhead: storedLetterhead(report.letterhead),
  };
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

async function gather(
  actor: Actor,
  input: { studentUserId: string; periodStart: Date; periodEnd: Date },
) {
  const read = await withTenant(actor.organizationId, async (tx) => {
    // Membership, not the users table. User rows are global; being able to name
    // somebody is not the same as them being your student.
    const membership = await tx.membership.findFirst({
      where: { userId: input.studentUserId, role: "STUDENT" },
    });
    if (!membership) return null;

    const student = await tx.user.findFirst({
      where: { id: input.studentUserId },
      select: { fullName: true },
    });
    if (!student) return null;

    const enrolments = await tx.classEnrolment.findMany({
      where: { studentUserId: input.studentUserId, status: "ACTIVE" },
      select: { classId: true },
    });
    const classes = await tx.class.findMany({
      where: { id: { in: enrolments.map((e) => e.classId) } },
      select: { id: true, name: true, subjectId: true },
    });

    const mastery = await tx.studentConceptMastery.findMany({
      where: { studentUserId: input.studentUserId },
    });

    // Every evidence row, not just the period's: the opening estimate is the
    // posterior as it stood when the period began, which needs everything
    // BEFORE it too.
    const evidence = await tx.conceptEvidence.findMany({
      where: {
        studentUserId: input.studentUserId,
        observedAt: { lte: input.periodEnd },
      },
      select: {
        conceptId: true,
        score: true,
        difficulty: true,
        weight: true,
        observedAt: true,
      },
    });

    const attempts = await tx.attempt.findMany({
      where: {
        studentUserId: input.studentUserId,
        submittedAt: { gte: input.periodStart, lte: input.periodEnd },
      },
      select: {
        id: true,
        assignmentId: true,
        submittedAt: true,
        rawScore: true,
        maxScore: true,
        // Every marked answer, so "still being marked" is derived the same way
        // the teacher's results page derives it rather than guessed at here.
        answers: { select: { awardedMarks: true, response: true } },
      },
    });

    const assignments = await tx.assignment.findMany({
      where: { id: { in: attempts.map((a) => a.assignmentId) } },
      select: {
        id: true,
        closesAt: true,
        resultsPolicy: true,
        resultsReleasedAt: true,
        assessmentId: true,
      },
    });

    const assessments = await tx.assessment.findMany({
      where: { id: { in: assignments.map((a) => a.assessmentId) } },
      select: { id: true, title: true, subject: { select: { name: true } } },
    });

    return {
      student,
      classes,
      mastery,
      evidence,
      attempts,
      assignments,
      assessments,
    };
  });

  if (!read) return null;

  const subjectIds = [...new Set(read.classes.map((c) => c.subjectId))];
  const syllabus = await conceptsForSubjects(subjectIds);
  const inSyllabus = new Set(syllabus.map((row) => row.conceptId));
  const nameById = new Map(syllabus.map((row) => [row.conceptId, row.conceptName]));

  const concepts: ReportConcept[] = [];
  const measuredIds = new Set<string>();
  for (const row of read.mastery) {
    // A concept from another subject the student has since left is not part of
    // this report's denominator, and counting it would move the coverage figure
    // for a reason nobody could explain.
    if (inSyllabus.size > 0 && !inSyllabus.has(row.conceptId)) continue;
    const estimate = row.estimate === null ? null : Number(row.estimate);
    concepts.push({
      conceptId: row.conceptId,
      conceptName: nameById.get(row.conceptId) ?? "this idea",
      estimate,
      band: row.band as ReportConcept["band"],
      evidenceCount: row.evidenceCount,
    });
    if (estimate !== null && row.band !== "INSUFFICIENT") {
      measuredIds.add(row.conceptId);
    }
  }

  const unmeasuredCount = Math.max(0, syllabus.length - measuredIds.size);

  // The opening estimate: the same pure estimator, over the same ledger rows,
  // filtered to what was known on the day the period began. This is the
  // property the two-table split was built for.
  const openingEstimates = new Map<string, number>();
  const beforePeriod = new Map<string, Evidence[]>();
  for (const row of read.evidence) {
    if (row.observedAt >= input.periodStart) continue;
    const list = beforePeriod.get(row.conceptId) ?? [];
    list.push({
      score: Number(row.score),
      difficulty: row.difficulty as Evidence["difficulty"],
      mapping: Number(row.weight),
      observedAt: row.observedAt,
    });
    beforePeriod.set(row.conceptId, list);
  }
  for (const [conceptId, rows] of beforePeriod) {
    const opening = estimateMastery(rows, input.periodStart);
    if (opening.band !== "INSUFFICIENT") {
      openingEstimates.set(conceptId, opening.estimate);
    }
  }

  const assignmentById = new Map(read.assignments.map((a) => [a.id, a]));
  const assessmentById = new Map(read.assessments.map((a) => [a.id, a]));
  const sittings: ReportSitting[] = [];
  for (const attempt of read.attempts) {
    const assignment = assignmentById.get(attempt.assignmentId);
    if (!assignment || attempt.submittedAt === null) continue;
    const assessment = assessmentById.get(assignment.assessmentId);

    // The same gate the student's own result page uses, and it is checked as
    // at the END of the period rather than now: a report dated September must
    // not start showing an October release when it is reprinted.
    const visible = resultsVisible(
      {
        closesAt: assignment.closesAt,
        resultsPolicy: assignment.resultsPolicy,
        resultsReleasedAt: assignment.resultsReleasedAt,
      },
      input.periodEnd,
    );

    // Null is not zero, all the way here. An unmarked written answer must not
    // become a nought in a document somebody keeps.
    const pendingMarks = attempt.answers.reduce(
      (sum, answer) =>
        answer.awardedMarks === null && answer.response !== null ? sum + 1 : sum,
      0,
    );
    const awarded = attempt.rawScore === null ? null : Number(attempt.rawScore);
    const total = attempt.maxScore === null ? null : Number(attempt.maxScore);

    sittings.push({
      assignmentId: assignment.id,
      title: assessment?.title ?? "A test",
      subjectName: assessment?.subject.name ?? "",
      satAt: attempt.submittedAt,
      attempts: 1,
      percentage:
        visible && awarded !== null && total !== null && total > 0
          ? awarded / total
          : null,
      awarded: visible ? awarded : null,
      total: visible ? total : null,
      fullyMarked: pendingMarks === 0,
    });
  }

  // One row per PAPER, carrying their best result and how many goes it took.
  //
  // Four attempts at one paper produced four rows with the same title and the
  // same date, which on a sheet handed to a parent reads as a fault in the
  // product and overstates how much testing happened. The BEST is reported
  // rather than the last: multiple attempts exist so a student can improve, and
  // reporting the final go would punish somebody for trying again after a good
  // one.
  const byAssignment = new Map<string, ReportSitting>();
  for (const sitting of sittings) {
    const existing = byAssignment.get(sitting.assignmentId);
    if (!existing) {
      byAssignment.set(sitting.assignmentId, sitting);
      continue;
    }
    existing.attempts += 1;
    existing.satAt =
      sitting.satAt > existing.satAt ? sitting.satAt : existing.satAt;
    // An unmarked answer anywhere in the paper keeps the whole row honest.
    existing.fullyMarked = existing.fullyMarked && sitting.fullyMarked;
    if ((sitting.percentage ?? -1) > (existing.percentage ?? -1)) {
      existing.percentage = sitting.percentage;
      existing.awarded = sitting.awarded;
      existing.total = sitting.total;
    }
  }
  const perPaper = [...byAssignment.values()].sort(
    (a, b) => a.satAt.getTime() - b.satAt.getTime(),
  );

  return {
    studentName: read.student.fullName,
    className: read.classes[0]?.name ?? null,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    concepts,
    unmeasuredCount,
    sittings: perPaper,
    openingEstimates,
  };
}
