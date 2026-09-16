import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { conceptsForSubjects } from "@/core/curriculum/concepts";
import { MAX_SET, MIN_SET } from "./recommend";

/**
 * A teacher telling a class to practise one idea.
 *
 * ---------------------------------------------------------------------------
 * It is still practice
 * ---------------------------------------------------------------------------
 * Everything a student then does runs through `core/practice`: the same
 * adaptive selection, the same feedback after every question, the same
 * evidence at `PRACTICE_WEIGHT`. A teacher asking for it does not make it a
 * supervised paper — and the moment assigned practice is scored like one, the
 * tutor's rule (help means no evidence) starts costing a student marks and
 * practice becomes a thing to be anxious about.
 *
 * So there is no marks field here, no pass mark, and no submission. What this
 * table adds is the INSTRUCTION: which idea, how many, by when.
 *
 * ---------------------------------------------------------------------------
 * Late is not a penalty
 * ---------------------------------------------------------------------------
 * `dueAt` orders the study plan and nothing else. Nothing goes red, nothing is
 * marked down, and an overdue set is still one tap from being done — a plan
 * that is already behind is one a student closes rather than catches up on.
 *
 * ---------------------------------------------------------------------------
 * It refuses before it promises
 * ---------------------------------------------------------------------------
 * Practice needs machine-markable questions on that concept in that school's
 * bank. Assigning ten questions where the bank holds two would put a card on
 * thirty students' home pages that cannot be honoured — the same refusal
 * `planRemedial` makes with the number named, rather than reaching for a
 * neighbouring concept.
 */

export type TeacherActor = { organizationId: string; userId: string; role: string };

export type AssignInput = {
  classId: string;
  conceptId: string;
  questionCount: number;
  dueAt?: Date | null;
  note?: string | null;
};

export type AssignResult =
  | { ok: true; id: string }
  | { ok: false; reason: "not-found" | "thin-bank" | "invalid"; message: string };

/** What a set may be, matching what `startPractice` will actually serve. */
export function clampCount(wanted: number): number {
  return Math.min(MAX_SET, Math.max(MIN_SET, Math.round(wanted)));
}

export async function assignPractice(
  actor: TeacherActor,
  input: AssignInput,
): Promise<AssignResult> {
  const count = clampCount(input.questionCount);

  const prepared = await withTenant(actor.organizationId, async (tx) => {
    const klass = await tx.class.findFirst({
      where: { id: input.classId, deletedAt: null },
      select: { id: true, subjectId: true, name: true },
    });
    if (!klass) return { error: "not-found" as const };

    // How many APPROVED, machine-markable questions this school holds on the
    // concept. Practice cannot serve a written answer: there is nobody waiting
    // to mark it, so serving one would promise feedback that never arrives.
    const available = await tx.$queryRaw<{ n: bigint }[]>`
      select count(distinct q.id) as n
      from questions q
      join question_outcomes qo on qo.question_id = q.id
      join concept_outcomes co on co.learning_outcome_id = qo.learning_outcome_id
      where q.organization_id = ${actor.organizationId}::uuid
        and q.status = 'APPROVED'
        and q.deleted_at is null
        and q.type in ('MCQ', 'MULTI_SELECT', 'TRUE_FALSE', 'NUMERIC', 'FILL_BLANK')
        and co.concept_id = ${input.conceptId}::uuid
    `;
    return { klass, available: Number(available[0]?.n ?? 0) };
  });

  if ("error" in prepared) {
    return { ok: false, reason: "not-found", message: "We could not find that class." };
  }

  // The concept has to belong to the class's own subject. A Maths class set
  // practice on a History idea would file its evidence under a syllabus those
  // students are not being measured on — the same coherence check the question
  // editor makes, and for the same reason.
  const subjectConcepts = await conceptsForSubjects([prepared.klass.subjectId]);
  const concept = subjectConcepts.find((row) => row.conceptId === input.conceptId);
  if (!concept) {
    return {
      ok: false,
      reason: "invalid",
      message: "That idea is not part of this class's subject.",
    };
  }

  if (prepared.available < count) {
    return {
      ok: false,
      reason: "thin-bank",
      message:
        prepared.available === 0
          ? `The bank holds no practice questions on ${concept.conceptName} yet. Add some, and this can be set.`
          : `The bank holds ${prepared.available} practice question${prepared.available === 1 ? "" : "s"} on ${concept.conceptName}, and you asked for ${count}.`,
    };
  }

  const id = randomUUID();
  await withTenant(actor.organizationId, (tx) =>
    tx.assignedPractice.createMany({
      data: [
        {
          id,
          organizationId: actor.organizationId,
          classId: input.classId,
          conceptId: input.conceptId,
          conceptName: concept.conceptName,
          questionCount: count,
          dueAt: input.dueAt ?? null,
          note: input.note?.trim() ? input.note.trim() : null,
          createdById: actor.userId,
        },
      ],
    }),
  );

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "practice.assigned",
    entityType: "class",
    entityId: input.classId,
    after: { conceptId: input.conceptId, questionCount: count, dueAt: input.dueAt ?? null },
  });

  return { ok: true, id };
}

/** Withdraw one. A stamp, never a delete — the sittings already point at it. */
export async function cancelAssignedPractice(
  actor: TeacherActor,
  id: string,
): Promise<{ ok: boolean }> {
  const found = await withTenant(actor.organizationId, async (tx) => {
    const row = await tx.assignedPractice.findFirst({ where: { id, cancelledAt: null } });
    if (!row) return null;
    await tx.assignedPractice.update({ where: { id }, data: { cancelledAt: new Date() } });
    return row;
  });
  if (!found) return { ok: false };

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "practice.assignment_cancelled",
    entityType: "class",
    entityId: found.classId,
    after: { assignedPracticeId: id },
  });
  return { ok: true };
}

export type TeacherRow = {
  id: string;
  conceptId: string;
  conceptName: string;
  questionCount: number;
  dueAt: Date | null;
  note: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
  /** Students who finished a set for it, out of those enrolled. */
  done: number;
  started: number;
  expected: number;
};

/**
 * What a teacher sees: who has done it.
 *
 * Counts, never a score. There is no mark to show, and "8 of 30 have done it"
 * is the only thing a teacher can act on here.
 */
export async function listForClass(
  organizationId: string,
  classId: string,
): Promise<TeacherRow[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx.assignedPractice.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    if (rows.length === 0) return [];

    const enrolled = await tx.classEnrolment.count({
      where: { classId, status: "ACTIVE" },
    });

    const sessions = await tx.practiceSession.findMany({
      where: { assignedPracticeId: { in: rows.map((row) => row.id) } },
      select: { assignedPracticeId: true, studentUserId: true, completedAt: true },
    });

    return rows.map((row) => {
      const mine = sessions.filter((session) => session.assignedPracticeId === row.id);
      const done = new Set(
        mine.filter((session) => session.completedAt !== null).map((s) => s.studentUserId),
      );
      const started = new Set(mine.map((session) => session.studentUserId));
      return {
        id: row.id,
        conceptId: row.conceptId,
        conceptName: row.conceptName,
        questionCount: row.questionCount,
        dueAt: row.dueAt,
        note: row.note,
        createdAt: row.createdAt,
        cancelledAt: row.cancelledAt,
        done: done.size,
        started: started.size,
        expected: enrolled,
      };
    });
  });
}

export type StudentRow = {
  id: string;
  conceptId: string;
  conceptName: string;
  questionCount: number;
  dueAt: Date | null;
  note: string | null;
  className: string;
  /** Their own state: nothing yet, a set open, or finished. */
  state: "TODO" | "IN_PROGRESS" | "DONE";
  sessionId: string | null;
};

/**
 * What one student still has to do.
 *
 * A finished one drops off the list rather than sitting there with a tick: the
 * same rule the study plan follows, where an item leaves when the evidence
 * moves. Cancelled ones disappear too — a withdrawn instruction is not an
 * outstanding one.
 */
export async function openForStudent(
  organizationId: string,
  studentUserId: string,
): Promise<StudentRow[]> {
  return withTenant(organizationId, async (tx) => {
    const enrolments = await tx.classEnrolment.findMany({
      where: { studentUserId, status: "ACTIVE" },
      select: { classId: true, class: { select: { name: true } } },
    });
    if (enrolments.length === 0) return [];

    const rows = await tx.assignedPractice.findMany({
      where: {
        classId: { in: enrolments.map((row) => row.classId) },
        cancelledAt: null,
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: 20,
    });
    if (rows.length === 0) return [];

    const sessions = await tx.practiceSession.findMany({
      where: {
        studentUserId,
        assignedPracticeId: { in: rows.map((row) => row.id) },
      },
      select: { id: true, assignedPracticeId: true, completedAt: true },
      orderBy: { startedAt: "desc" },
    });

    const classNameById = new Map(
      enrolments.map((row) => [row.classId, row.class.name]),
    );

    return rows
      .map((row) => {
        const mine = sessions.filter((session) => session.assignedPracticeId === row.id);
        const finished = mine.find((session) => session.completedAt !== null);
        const open = mine.find((session) => session.completedAt === null);
        return {
          id: row.id,
          conceptId: row.conceptId,
          conceptName: row.conceptName,
          questionCount: row.questionCount,
          dueAt: row.dueAt,
          note: row.note,
          className: classNameById.get(row.classId) ?? "",
          state: finished ? ("DONE" as const) : open ? ("IN_PROGRESS" as const) : ("TODO" as const),
          sessionId: open?.id ?? null,
        };
      })
      .filter((row) => row.state !== "DONE");
  });
}

/** One row, for the route that starts it. */
export async function getAssignedPractice(organizationId: string, id: string) {
  return withTenant(organizationId, (tx) =>
    tx.assignedPractice.findFirst({ where: { id, cancelledAt: null } }),
  );
}
