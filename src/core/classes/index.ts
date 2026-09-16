import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";

/**
 * Classes.
 *
 * A class is a teaching group: grade + subject + section + academic year.
 * "Class 10" is a grade; "Class 10-A Mathematics" is a class. The distinction
 * matters because mastery is measured per class and a student may sit in two.
 */

export type ClassSummary = {
  id: string;
  name: string;
  gradeLabel: string;
  gradeNumber: number;
  subjectName: string;
  subjectShortName: string;
  academicYear: string;
  joinCode: string | null;
  studentCount: number;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: Date;
};

/**
 * Join codes are read aloud in a classroom and typed on a phone, so the
 * alphabet excludes every pair that is misread: no O/0, no I/1/L, no S/5,
 * no B/8, no Z/2. Six characters from 26 symbols is ~309 million codes, which
 * is ample for a lookup that is rate-limited and rotatable.
 */
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";

export function generateJoinCode(): string {
  let code = "";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

export async function listClasses(
  organizationId: string,
  teacherUserId?: string,
): Promise<ClassSummary[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx.class.findMany({
      where: {
        deletedAt: null,
        ...(teacherUserId ? { ownerTeacherId: teacherUserId } : {}),
      },
      include: {
        grade: true,
        subject: true,
        _count: { select: { enrolments: { where: { status: "ACTIVE" } } } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      gradeLabel: row.grade.label,
      gradeNumber: row.grade.number,
      subjectName: row.subject.name,
      subjectShortName: row.subject.shortName,
      academicYear: row.academicYear,
      joinCode: row.joinCode,
      studentCount: row._count.enrolments,
      status: row.status,
      createdAt: row.createdAt,
    }));
  });
}

export async function getClass(organizationId: string, classId: string) {
  return withTenant(organizationId, async (tx) => {
    const found = await tx.class.findFirst({
      where: { id: classId, deletedAt: null },
      include: { grade: true, subject: true },
    });
    if (!found) return null;

    const enrolments = await tx.classEnrolment.findMany({
      where: { classId, status: "ACTIVE" },
      orderBy: { joinedAt: "asc" },
    });

    const studentIds = enrolments.map((e) => e.studentUserId);
    const [users, profiles] = await Promise.all([
      tx.user.findMany({ where: { id: { in: studentIds } } }),
      tx.studentProfile.findMany({ where: { userId: { in: studentIds } } }),
    ]);

    const byId = new Map(users.map((u) => [u.id, u]));
    const profileById = new Map(profiles.map((p) => [p.userId, p]));

    const students = enrolments.flatMap((enrolment) => {
      const user = byId.get(enrolment.studentUserId);
      if (!user) return [];
      const profile = profileById.get(enrolment.studentUserId);
      return [
        {
          userId: user.id,
          fullName: user.fullName,
          phone: user.phone,
          rollNumber: profile?.rollNumber ?? null,
          joinedAt: enrolment.joinedAt,
          // A student with no phone cannot receive a sign-in code, so they
          // cannot take a test. Surfaced rather than discovered on exam day.
          canSignIn: Boolean(user.phone),
        },
      ];
    });

    return {
      id: found.id,
      name: found.name,
      gradeLabel: found.grade.label,
      gradeNumber: found.grade.number,
      subjectName: found.subject.name,
      // Needed to ask which concepts this class could possibly practise: a
      // class may only be set practice on its own subject.
      subjectId: found.subjectId,
      academicYear: found.academicYear,
      joinCode: found.joinCode,
      status: found.status,
      students,
    };
  });
}

/**
 * How far a class is from being measured, read from the rows rather than
 * guessed: students on the roster, a published paper in the class's subject
 * and year, and a paper actually handed to this class.
 */
export async function classSetup(
  organizationId: string,
  classId: string,
): Promise<{ hasStudents: boolean; hasPublishedPaper: boolean; hasAssignment: boolean } | null> {
  return withTenant(organizationId, async (tx) => {
    const found = await tx.class.findFirst({
      where: { id: classId, deletedAt: null },
      select: { subjectId: true, gradeId: true },
    });
    if (!found) return null;
    const [students, papers, assignments] = await Promise.all([
      tx.classEnrolment.count({ where: { classId, status: "ACTIVE" } }),
      tx.assessment.count({
        where: {
          subjectId: found.subjectId,
          gradeId: found.gradeId,
          status: { in: ["PUBLISHED", "CLOSED"] },
          deletedAt: null,
        },
      }),
      tx.assignment.count({ where: { classId, cancelledAt: null } }),
    ]);
    return {
      hasStudents: students > 0,
      hasPublishedPaper: papers > 0,
      hasAssignment: assignments > 0,
    };
  });
}

export type CreateClassInput = {
  name: string;
  gradeId: string;
  subjectId: string;
  academicYear: string;
};

export async function createClass(
  actor: { organizationId: string; userId: string; role: string },
  input: CreateClassInput,
  /** The plan's class seats, from `classSeats()`. Omitted, no limit applies. */
  seats?: { remaining: number | null },
): Promise<{ id: string; joinCode: string }> {
  const joinCode = generateJoinCode();

  const created = await withTenant(actor.organizationId, async (tx) => {
    // The subject must belong to the grade, AND the grade to the board this
    // organization teaches. Without the first a teacher could pair Class 9 with
    // a Class 10 subject through a hand-made request; without the second they
    // could pair their school with another board's tree entirely, and every
    // downstream mastery number would be filed against a syllabus nobody here
    // teaches.
    //
    // The board is read from the organization row inside the tenant
    // transaction — never from the request, which does not carry one.
    const organization = await tx.organization.findFirst({
      where: { id: actor.organizationId },
      select: { boardId: true },
    });
    if (!organization) throw new InvalidCurriculumSelection();

    const subject = await tx.subject.findFirst({
      where: {
        id: input.subjectId,
        gradeId: input.gradeId,
        grade: { boardId: organization.boardId },
      },
    });
    if (!subject) {
      throw new InvalidCurriculumSelection();
    }
    if (seats && seats.remaining === 0) {
      throw new ClassLimitReached();
    }

    const row = await tx.class.create({
      data: {
        id: randomUUID(),
        organizationId: actor.organizationId,
        name: input.name.trim(),
        gradeId: input.gradeId,
        subjectId: input.subjectId,
        academicYear: input.academicYear,
        ownerTeacherId: actor.userId,
        joinCode,
      },
    });

    await tx.classTeacher.create({
      data: {
        id: randomUUID(),
        organizationId: actor.organizationId,
        classId: row.id,
        teacherUserId: actor.userId,
        role: "PRIMARY",
      },
    });

    return row;
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "class.created",
    entityType: "class",
    entityId: created.id,
    after: { name: created.name, academicYear: created.academicYear },
  });

  return { id: created.id, joinCode };
}

export async function rotateJoinCode(
  actor: { organizationId: string; userId: string; role: string },
  classId: string,
): Promise<string> {
  const joinCode = generateJoinCode();

  const updated = await withTenant(actor.organizationId, (tx) =>
    tx.class.updateMany({
      where: { id: classId, deletedAt: null },
      data: { joinCode },
    }),
  );
  if (updated.count === 0) return "";

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "class.join_code_rotated",
    entityType: "class",
    entityId: classId,
  });

  return joinCode;
}

export class ClassLimitReached extends Error {
  constructor() {
    super("The plan's class limit has been reached.");
    this.name = "ClassLimitReached";
  }
}

export class InvalidCurriculumSelection extends Error {
  constructor() {
    super("That subject is not taught in that class year.");
    this.name = "InvalidCurriculumSelection";
  }
}
