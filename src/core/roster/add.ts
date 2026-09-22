import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { identifierTaken } from "@/db/unscoped";
import { writeAudit } from "@/core/identity/audit";
import type { ParsedStudent } from "./parse";

/**
 * Committing a parsed roster.
 *
 * The dry run and the commit share `parse.ts` and this module's row checks, so
 * the preview a teacher approves is produced by the same code that does the
 * work. A preview running different logic from the commit is a preview that
 * lies, and the teacher finds out after pressing the button.
 */

export type RowOutcome =
  | { line: number; fullName: string; status: "added"; userId: string; warning?: string }
  | { line: number; fullName: string; status: "skipped"; reason: string };

export type RosterResult = {
  added: number;
  skipped: number;
  outcomes: RowOutcome[];
};

/**
 * The plan's student seats for this import. `remaining: null` is unlimited;
 * omitted entirely, no limit is applied. `reason` is what a row past the limit
 * is told.
 */
export type RosterSeats = { remaining: number | null; reason: string };

/**
 * Checks a parsed roster against the database without writing anything.
 * Every reason returned here is a reason the commit would skip the same row —
 * `plan` below is the one walk both share.
 */
export async function dryRunRoster(
  organizationId: string,
  classId: string,
  students: ParsedStudent[],
  seats?: RosterSeats,
): Promise<RowOutcome[]> {
  const existing = await loadExisting(organizationId, classId, students);
  return plan(students, existing, seats, () => "");
}

export async function addStudents(
  actor: { organizationId: string; userId: string; role: string },
  classId: string,
  students: ParsedStudent[],
  seats?: RosterSeats,
): Promise<RosterResult> {
  const { organizationId } = actor;
  const existing = await loadExisting(organizationId, classId, students);

  const outcomes = plan(students, existing, seats, () => randomUUID());
  const byLine = new Map(students.map((s) => [s.line, s]));
  const toCreate = outcomes.flatMap((outcome) =>
    outcome.status === "added"
      ? [{ userId: outcome.userId, student: byLine.get(outcome.line)! }]
      : [],
  );

  if (toCreate.length > 0) {
    await withTenant(organizationId, async (tx) => {
      // createMany, not create, and with ids generated here.
      //
      // Postgres applies the SELECT policy to an INSERT ... RETURNING, and the
      // `users` SELECT policy resolves through membership — which does not
      // exist yet at this point. A `create()` would therefore insert the row
      // and then fail reading it back. See the note in prisma/rls.sql.
      await tx.user.createMany({
        data: toCreate.map(({ userId, student }) => ({
          id: userId,
          fullName: student.fullName,
          phone: student.phone ?? null,
          status: "ACTIVE" as const,
        })),
      });

      await tx.membership.createMany({
        data: toCreate.map(({ userId }) => ({
          id: randomUUID(),
          organizationId,
          userId,
          role: "STUDENT" as const,
          status: "ACTIVE" as const,
          joinedAt: new Date(),
        })),
      });

      await tx.studentProfile.createMany({
        data: toCreate.map(({ userId, student }) => ({
          userId,
          organizationId,
          rollNumber: student.rollNumber ?? null,
          apaarId: student.apaarId ?? null,
        })),
      });

      await tx.classEnrolment.createMany({
        data: toCreate.map(({ userId }) => ({
          id: randomUUID(),
          organizationId,
          classId,
          studentUserId: userId,
          status: "ACTIVE" as const,
        })),
      });
    });
  }

  const added = outcomes.filter((o) => o.status === "added").length;

  await writeAudit({
    organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "roster.students_added",
    entityType: "class",
    entityId: classId,
    after: { added, skipped: outcomes.length - added },
  });

  return { added, skipped: outcomes.length - added, outcomes };
}

export async function removeStudent(
  actor: { organizationId: string; userId: string; role: string },
  classId: string,
  studentUserId: string,
): Promise<boolean> {
  const result = await withTenant(actor.organizationId, (tx) =>
    // Enrolment is time-bounded rather than deleted, so a student who transfers
    // mid-year keeps their history without appearing in the new class's past
    // results.
    tx.classEnrolment.updateMany({
      where: { classId, studentUserId, status: "ACTIVE" },
      data: { status: "REMOVED", leftAt: new Date() },
    }),
  );

  if (result.count === 0) return false;

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "roster.student_removed",
    entityType: "class",
    entityId: classId,
    after: { studentUserId },
  });

  return true;
}

// ---------------------------------------------------------------------------

type Existing = {
  /** Normalised name → whether ANY current member with that name has no phone. */
  names: Map<string, boolean>;
  rolls: Set<string>;
  /** APAAR IDs already on a student here, and those claimed earlier in this list. */
  apaars: Set<string>;
  takenPhones: Set<string>;
};

async function loadExisting(
  organizationId: string,
  classId: string,
  students: ParsedStudent[],
): Promise<Existing> {
  const { names, rolls, apaars } = await withTenant(organizationId, async (tx) => {
    const enrolments = await tx.classEnrolment.findMany({
      where: { classId, status: "ACTIVE" },
      select: { studentUserId: true },
    });
    const ids = enrolments.map((e) => e.studentUserId);

    const [users, profiles] = await Promise.all([
      tx.user.findMany({
        where: { id: { in: ids } },
        select: { fullName: true, phone: true },
      }),
      tx.studentProfile.findMany({
        where: { organizationId },
        select: { rollNumber: true, apaarId: true },
      }),
    ]);

    const names = new Map<string, boolean>();
    for (const u of users) {
      const key = normaliseName(u.fullName);
      names.set(key, (names.get(key) ?? false) || !u.phone);
    }

    return {
      names,
      rolls: new Set(
        profiles.flatMap((p) => (p.rollNumber ? [p.rollNumber.toLowerCase()] : [])),
      ),
      apaars: new Set(profiles.flatMap((p) => (p.apaarId ? [p.apaarId] : []))),
    };
  });

  // Phone uniqueness is global, not per-tenant, so it cannot be checked inside
  // withTenant. The narrow SECURITY DEFINER function answers only "is this
  // taken", never by whom — one tenant must not be able to enumerate another's
  // students by trying phone numbers.
  const takenPhones = new Set<string>();
  const phones = [...new Set(students.flatMap((s) => (s.phone ? [s.phone] : [])))];
  for (const phone of phones) {
    if (await identifierTaken(null, phone)) takenPhones.add(phone);
  }

  return { names, rolls, apaars, takenPhones };
}

function plan(
  students: ParsedStudent[],
  existing: Existing,
  seats: RosterSeats | undefined,
  newId: () => string,
): RowOutcome[] {
  const outcomes: RowOutcome[] = [];
  const seenRolls = new Set<string>();
  const seenPhones = new Set<string>();
  let left = seats?.remaining ?? null;

  for (const student of students) {
    let reason = rowProblem(student, existing, seenRolls);
    // The phone is the identity, so the same number twice in one list is the
    // same student twice — and the second insert would break the unique index.
    if (!reason && student.phone && seenPhones.has(student.phone)) {
      reason = "This mobile number is already on an earlier line of this list.";
    }
    // Past the plan's limit the row is skipped with the reason, in the preview
    // and the commit alike, so the teacher sees how many would not fit before
    // pressing anything.
    if (!reason && left !== null && left <= 0) reason = seats!.reason;
    if (reason) {
      outcomes.push({ line: student.line, fullName: student.fullName, status: "skipped", reason });
      continue;
    }
    if (left !== null) left--;
    if (student.phone) seenPhones.add(student.phone);
    if (student.rollNumber) seenRolls.add(student.rollNumber.toLowerCase());
    if (student.apaarId) existing.apaars.add(student.apaarId);
    const sameName = existing.names.has(normaliseName(student.fullName));
    outcomes.push({
      line: student.line,
      fullName: student.fullName,
      status: "added",
      userId: newId(),
      ...(sameName
        ? { warning: "Another student in this class has the same name. Added as a different student." }
        : {}),
    });
  }

  return outcomes;
}

function rowProblem(
  student: ParsedStudent,
  existing: Existing,
  seenRolls: Set<string>,
): string | null {
  // A name is not an identity: two students in one class can be called Arun
  // Kumar, and refusing the second by name alone kept a real child off the
  // roster. The phone is the identity, and a phone already on an account is
  // refused below. The one case refused here is a row with no phone matching a
  // member who has none either — nothing tells them apart, and it is almost
  // always the same list pasted twice.
  const phoneless = existing.names.get(normaliseName(student.fullName));
  if (phoneless === true && !student.phone) {
    return "A student with this name and no mobile number is already in this class. Add their mobile number if this is a different student.";
  }

  if (student.rollNumber) {
    const roll = student.rollNumber.toLowerCase();
    if (existing.rolls.has(roll) || seenRolls.has(roll)) {
      return `Roll number ${student.rollNumber} is already used in this organisation.`;
    }
  }

  // The same APAAR ID twice in one school is the same child twice.
  if (student.apaarId && existing.apaars.has(student.apaarId)) {
    return `APAAR ID ${student.apaarId} is already on a student in this organisation.`;
  }

  if (student.phone && existing.takenPhones.has(student.phone)) {
    // Deliberately not "this student is at another centre" — that would let one
    // tenant probe another's roster a phone number at a time.
    //
    // It is also the correct flow rather than a limitation: a student who
    // already has an account joins a second class themselves, with the class
    // code, from their own signed-in session. A teacher must not be able to
    // attach an arbitrary phone number to their roster.
    return "That mobile number already has an account. Share the class code so they can join it themselves.";
  }

  return null;
}

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}
