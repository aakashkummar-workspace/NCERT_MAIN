import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { expectedStudentIds } from "./cohort";
import {
  assignmentStatus,
  validateWindow,
  type AssignmentStatus,
  type WindowProblem,
} from "./window";

/**
 * Assignments: a published paper given to a class, in a window.
 *
 * The rules:
 *
 *   1. **Only a PUBLISHED assessment can be assigned.** A draft has no frozen
 *      question versions, so what a student saw could not be reconstructed.
 *   2. **The class must study the paper's subject.** Same mis-filing guard as
 *      everywhere else.
 *   3. **Targeting a subset means naming students who are actually enrolled.**
 *   4. **Status is derived, never stored** — see ./window.
 */

export type Actor = { organizationId: string; userId: string; role: string };

export type CreateInput = {
  assessmentId: string;
  classId: string;
  opensAt: Date;
  closesAt: Date;
  durationOverrideMinutes?: number | null;
  maxAttempts: number;
  resultsPolicy: "IMMEDIATE" | "AFTER_CLOSE" | "MANUAL";
  /** Empty means the whole class, including anyone who joins tomorrow. */
  studentUserIds?: string[];
};

export type CreateResult =
  | { ok: true; id: string }
  | { ok: false; message: string; problems?: WindowProblem[] };

export async function createAssignment(
  actor: Actor,
  input: CreateInput,
): Promise<CreateResult> {
  type Prepared =
    | { error: string }
    | {
        assessment: {
          id: string;
          status: string;
          subjectId: string;
          durationMinutes: number;
          title: string;
        };
        klass: { id: string; subjectId: string; name: string };
        targets: string[];
      };

  const prepared = await withTenant<Prepared>(actor.organizationId, async (tx) => {
    const assessment = await tx.assessment.findFirst({
      where: { id: input.assessmentId, deletedAt: null },
      select: {
        id: true,
        status: true,
        subjectId: true,
        durationMinutes: true,
        title: true,
      },
    });
    if (!assessment) return { error: "We could not find that assessment." };

    if (assessment.status !== "PUBLISHED") {
      // A draft has no frozen versions, so what a student saw could never be
      // reconstructed afterwards.
      return {
        error:
          "Only a published assessment can be assigned. Publishing freezes the question wording, which is what makes a result defensible later.",
      };
    }

    const klass = await tx.class.findFirst({
      where: { id: input.classId, deletedAt: null },
      select: { id: true, subjectId: true, name: true },
    });
    if (!klass) return { error: "We could not find that class." };
    if (klass.subjectId !== assessment.subjectId) {
      return { error: "That class does not study this subject." };
    }

    const targets = [...new Set(input.studentUserIds ?? [])];
    if (targets.length > 0) {
      const enrolled = await tx.classEnrolment.findMany({
        where: {
          classId: input.classId,
          status: "ACTIVE",
          studentUserId: { in: targets },
        },
        select: { studentUserId: true },
      });
      if (enrolled.length !== targets.length) {
        return {
          error:
            "One of those students is not in this class. Add them to the class first.",
        };
      }
    }

    return { assessment, klass, targets };
  });

  if ("error" in prepared) return { ok: false, message: prepared.error };

  const problems = validateWindow({
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    durationMinutes: prepared.assessment.durationMinutes,
    durationOverrideMinutes: input.durationOverrideMinutes,
    maxAttempts: input.maxAttempts,
  });
  if (problems.length > 0) {
    return { ok: false, message: problems[0]!.message, problems };
  }

  const id = randomUUID();
  await withTenant(actor.organizationId, async (tx) => {
    await tx.assignment.create({
      data: {
        id,
        organizationId: actor.organizationId,
        assessmentId: input.assessmentId,
        classId: input.classId,
        assignedById: actor.userId,
        opensAt: input.opensAt,
        closesAt: input.closesAt,
        durationOverrideMinutes: input.durationOverrideMinutes ?? null,
        maxAttempts: input.maxAttempts,
        resultsPolicy: input.resultsPolicy,
      },
    });

    if (prepared.targets.length > 0) {
      await tx.assignmentTarget.createMany({
        data: prepared.targets.map((studentUserId) => ({
          id: randomUUID(),
          organizationId: actor.organizationId,
          assignmentId: id,
          studentUserId,
        })),
      });
    }
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "assignment.created",
    entityType: "assignment",
    entityId: id,
    after: {
      assessment: prepared.assessment.title,
      class: prepared.klass.name,
      opensAt: input.opensAt.toISOString(),
      closesAt: input.closesAt.toISOString(),
      targeted: prepared.targets.length || "whole class",
    },
  });

  return { ok: true, id };
}

export type AssignmentSummary = {
  id: string;
  assessmentId: string;
  assessmentTitle: string;
  classId: string;
  className: string;
  opensAt: Date;
  closesAt: Date;
  status: AssignmentStatus;
  maxAttempts: number;
  resultsPolicy: string;
  durationMinutes: number;
  targetedCount: number | null;
  classSize: number;
};

export async function listAssignments(
  organizationId: string,
  filters: { classId?: string; assessmentId?: string } = {},
): Promise<AssignmentSummary[]> {
  const now = new Date();
  return withTenant(organizationId, async (tx) => {
    const rows = await tx.assignment.findMany({
      where: {
        ...(filters.classId ? { classId: filters.classId } : {}),
        ...(filters.assessmentId ? { assessmentId: filters.assessmentId } : {}),
      },
      include: {
        assessment: { select: { title: true, durationMinutes: true } },
        class: {
          select: {
            name: true,
            _count: { select: { enrolments: { where: { status: "ACTIVE" } } } },
          },
        },
        _count: { select: { targets: true } },
      },
      orderBy: { opensAt: "desc" },
    });

    return rows.map((row) => ({
      id: row.id,
      assessmentId: row.assessmentId,
      assessmentTitle: row.assessment.title,
      classId: row.classId,
      className: row.class.name,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      status: assignmentStatus(row, now),
      maxAttempts: row.maxAttempts,
      resultsPolicy: row.resultsPolicy,
      durationMinutes:
        row.durationOverrideMinutes ?? row.assessment.durationMinutes,
      targetedCount: row._count.targets > 0 ? row._count.targets : null,
      classSize: row.class._count.enrolments,
    }));
  });
}

export async function getAssignment(organizationId: string, id: string) {
  const now = new Date();
  return withTenant(organizationId, async (tx) => {
    const row = await tx.assignment.findFirst({
      where: { id },
      include: {
        assessment: {
          select: {
            id: true,
            title: true,
            durationMinutes: true,
            totalMarks: true,
            _count: { select: { questions: true } },
          },
        },
        class: { select: { id: true, name: true } },
        // The named event this paper is part of, when it is part of one. Read
        // here rather than on the page, so the page cannot ask a second time
        // and get a different answer.
        examSeries: { select: { id: true, name: true } },
        targets: true,
      },
    });
    if (!row) return null;

    const targeted = new Set(row.targets.map((t) => t.studentUserId));
    const studentIds = await expectedStudentIds(tx, row);

    const students = await tx.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, fullName: true, phone: true },
    });

    const attempts = await tx.attempt.findMany({
      where: { assignmentId: id },
      select: {
        studentUserId: true,
        status: true,
        submitReason: true,
        attemptNumber: true,
      },
      orderBy: { attemptNumber: "desc" },
    });

    const latest = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      if (!latest.has(attempt.studentUserId)) latest.set(attempt.studentUserId, attempt);
    }

    return {
      id: row.id,
      assessmentId: row.assessmentId,
      assessmentTitle: row.assessment.title,
      questionCount: row.assessment._count.questions,
      totalMarks: row.assessment.totalMarks,
      classId: row.classId,
      className: row.class.name,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      status: assignmentStatus(row, now),
      durationMinutes:
        row.durationOverrideMinutes ?? row.assessment.durationMinutes,
      durationOverrideMinutes: row.durationOverrideMinutes,
      maxAttempts: row.maxAttempts,
      resultsPolicy: row.resultsPolicy,
      resultsReleasedAt: row.resultsReleasedAt,
      cancelledAt: row.cancelledAt,
      series: row.examSeries ? { id: row.examSeries.id, name: row.examSeries.name } : null,
      wholeClass: targeted.size === 0,
      students: students.map((student) => ({
        userId: student.id,
        fullName: student.fullName,
        // A student with no mobile cannot receive a sign-in code, so they
        // cannot sit this. Surfaced here rather than discovered on the day.
        canSignIn: Boolean(student.phone),
        attemptStatus: attemptStatusOf(latest.get(student.id)),
      })),
    };
  });
}

/**
 * How far a student got.
 *
 * A paper the clock closed is reported as EXPIRED rather than SUBMITTED, because
 * the two mean different things to a teacher looking down the list: one student
 * finished and pressed the button, the other ran out of time or walked away.
 */
function attemptStatusOf(
  attempt: { status: string; submitReason: string | null } | undefined,
): "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "EXPIRED" {
  if (!attempt) return "NOT_STARTED";
  if (attempt.status === "IN_PROGRESS") return "IN_PROGRESS";
  return attempt.submitReason === "TIMEOUT" || attempt.submitReason === "SWEEP"
    ? "EXPIRED"
    : "SUBMITTED";
}

export type UpdateInput = {
  opensAt?: Date;
  closesAt?: Date;
  durationOverrideMinutes?: number | null;
  maxAttempts?: number;
  resultsPolicy?: "IMMEDIATE" | "AFTER_CLOSE" | "MANUAL";
};

/**
 * Only the window and the policy. The paper itself is never changed through an
 * assignment — that is what duplicating an assessment is for.
 */
export async function updateAssignment(
  actor: Actor,
  id: string,
  patch: UpdateInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await getAssignment(actor.organizationId, id);
  if (!current) return { ok: false, message: "NOT_FOUND" };

  if (current.status === "CANCELLED") {
    return { ok: false, message: "This assignment was cancelled." };
  }

  const opensAt = patch.opensAt ?? current.opensAt;
  const closesAt = patch.closesAt ?? current.closesAt;
  const maxAttempts = patch.maxAttempts ?? current.maxAttempts;
  const override =
    patch.durationOverrideMinutes !== undefined
      ? patch.durationOverrideMinutes
      : current.durationOverrideMinutes;

  const problems = validateWindow({
    opensAt,
    closesAt,
    durationMinutes: current.durationMinutes,
    durationOverrideMinutes: override,
    maxAttempts,
    // An already-open window may legitimately be extended, so the
    // already-closed rule is measured against the NEW closing time only.
    now: new Date(),
  });
  if (problems.length > 0) return { ok: false, message: problems[0]!.message };

  await withTenant(actor.organizationId, (tx) =>
    tx.assignment.updateMany({
      where: { id },
      data: {
        opensAt,
        closesAt,
        maxAttempts,
        durationOverrideMinutes: override,
        ...(patch.resultsPolicy ? { resultsPolicy: patch.resultsPolicy } : {}),
      },
    }),
  );

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "assignment.updated",
    entityType: "assignment",
    entityId: id,
    before: {
      opensAt: current.opensAt.toISOString(),
      closesAt: current.closesAt.toISOString(),
    },
    after: { opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() },
  });

  return { ok: true };
}

export async function cancelAssignment(
  actor: Actor,
  id: string,
): Promise<boolean> {
  const result = await withTenant(actor.organizationId, (tx) =>
    tx.assignment.updateMany({
      where: { id, cancelledAt: null },
      data: { cancelledAt: new Date() },
    }),
  );
  if (result.count === 0) return false;

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "assignment.cancelled",
    entityType: "assignment",
    entityId: id,
  });
  return true;
}

export { assignmentStatus, validateWindow };
export type { AssignmentStatus };
