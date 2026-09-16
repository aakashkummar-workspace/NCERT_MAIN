import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  announcementsForStudent,
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncementsForClass,
} from "@/core/announcements";
import { createClass } from "@/core/classes";
import { addStudents } from "@/core/roster/add";
import { parseRoster } from "@/core/roster/parse";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

const owner = (world: World) => ({ ...teacherOf(world), role: "OWNER" });

/** A TEACHER member of the world's organization who teaches nothing yet. */
async function colleague(world: World) {
  const userId = randomUUID();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({
      data: [{ id: userId, fullName: "A Colleague", status: "ACTIVE" }],
    });
    await tx.membership.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          userId,
          role: "TEACHER",
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      ],
    });
  });
  return { organizationId: world.organizationId, userId, role: "TEACHER" };
}

/** A second class in the same organization, with one student of its own. */
async function secondClass(world: World) {
  const klass = await withTenant(world.organizationId, (tx) =>
    tx.class.findFirstOrThrow({ where: { id: world.classId } }),
  );
  const created = await createClass(owner(world), {
    name: "Class 10-B",
    gradeId: klass.gradeId,
    subjectId: klass.subjectId,
    academicYear: "2026-27",
  });
  const roster = await addStudents(
    owner(world),
    created.id,
    parseRoster(`Kabir ${randomUUID().slice(0, 6)}`).students,
  );
  const studentId = roster.outcomes.flatMap((o) => (o.status === "added" ? [o.userId] : []))[0]!;
  return { classId: created.id, studentId };
}

describe("posting an announcement", () => {
  it("lets the class's own teacher post, and every enrolled student see it", async () => {
    const world = await makeWorld();
    const posted = await createAnnouncement(
      teacherOf(world),
      world.classId,
      "  Monday's test covers chapters 1 and 2.\r\nBring a pencil.  ",
    );
    if (!posted.ok) throw new Error(posted.message);
    // Trimmed, and one kind of line break.
    expect(posted.announcement.body).toBe(
      "Monday's test covers chapters 1 and 2.\nBring a pencil.",
    );

    for (const studentId of [world.studentId, world.otherStudentId]) {
      const seen = await announcementsForStudent(world.organizationId, studentId);
      expect(seen.map((row) => row.id)).toContain(posted.announcement.id);
    }

    const list = await listAnnouncementsForClass(world.organizationId, world.classId);
    expect(list?.rows[0]?.id).toBe(posted.announcement.id);
    expect(list?.truncated).toBe(false);
  });

  it("writes an audit row carrying the length and never the words", async () => {
    const world = await makeWorld();
    const body = `A private note ${randomUUID()}`;
    const posted = await createAnnouncement(teacherOf(world), world.classId, body);
    if (!posted.ok) throw new Error(posted.message);

    const audit = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: "announcement.created", entityId: posted.announcement.id },
      }),
    );
    expect(JSON.stringify(audit)).not.toContain(body);
    expect(audit.after).toMatchObject({ classId: world.classId, length: body.length });
  });

  it("refuses an empty body and one over 1000 characters", async () => {
    const world = await makeWorld();
    const empty = await createAnnouncement(teacherOf(world), world.classId, "   \n ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("invalid");

    const long = await createAnnouncement(teacherOf(world), world.classId, "x".repeat(1001));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason).toBe("invalid");

    const exact = await createAnnouncement(teacherOf(world), world.classId, "x".repeat(1000));
    expect(exact.ok).toBe(true);
  });

  it("refuses the same body to the same class within two minutes — a double tap", async () => {
    const world = await makeWorld();
    const body = `Double tap ${randomUUID()}`;
    const first = await createAnnouncement(teacherOf(world), world.classId, body);
    expect(first.ok).toBe(true);

    const second = await createAnnouncement(teacherOf(world), world.classId, body);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("duplicate");

    // Two taps landing together are one message too.
    const other = `Race ${randomUUID()}`;
    const raced = await Promise.all([
      createAnnouncement(teacherOf(world), world.classId, other),
      createAnnouncement(teacherOf(world), world.classId, other),
    ]);
    expect(raced.filter((result) => result.ok)).toHaveLength(1);

    // Outside the window it is a teacher deliberately repeating themselves.
    const later = await createAnnouncement(teacherOf(world), world.classId, body, {
      now: new Date(Date.now() + 3 * 60_000),
    });
    expect(later.ok).toBe(true);
  });

  it("refuses a teacher who does not teach the class, and admits one who does", async () => {
    const world = await makeWorld();
    const teacher = await colleague(world);

    const refused = await createAnnouncement(teacher, world.classId, "Not my class.");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("forbidden");

    await withTenant(world.organizationId, (tx) =>
      tx.classTeacher.create({
        data: {
          id: randomUUID(),
          organizationId: world.organizationId,
          classId: world.classId,
          teacherUserId: teacher.userId,
          role: "ASSISTANT",
        },
      }),
    );
    const admitted = await createAnnouncement(teacher, world.classId, "Now it is.");
    expect(admitted.ok).toBe(true);
  });

  it("refuses a student, whatever class id they send", async () => {
    const world = await makeWorld();
    const result = await createAnnouncement(
      { organizationId: world.organizationId, userId: world.studentId, role: "STUDENT" },
      world.classId,
      "Hello everyone",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden");
  });

  it("answers a malformed or foreign class id as not found", async () => {
    const world = await makeWorld();
    const elsewhere = await makeWorld();

    const malformed = await createAnnouncement(owner(world), "not-a-uuid", "Hello");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.reason).toBe("not-found");

    // An owner of one organization, naming another organization's class.
    const foreign = await createAnnouncement(owner(world), elsewhere.classId, "Hello");
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toBe("not-found");
    expect(await listAnnouncementsForClass(world.organizationId, elsewhere.classId)).toBeNull();
  });
});

describe("who sees an announcement", () => {
  it("only students actively enrolled in that class, in that organization", async () => {
    const world = await makeWorld();
    const elsewhere = await makeWorld();
    const other = await secondClass(world);

    const body = `For 10-A only ${randomUUID()}`;
    const posted = await createAnnouncement(teacherOf(world), world.classId, body);
    if (!posted.ok) throw new Error(posted.message);

    // A student of another class in the same organization.
    const sameOrg = await announcementsForStudent(world.organizationId, other.studentId);
    expect(sameOrg.map((row) => row.body)).not.toContain(body);

    // A student in another organization — asked both ways round, and neither
    // tenant context reaches the row.
    const otherOrg = await announcementsForStudent(elsewhere.organizationId, elsewhere.studentId);
    expect(otherOrg.map((row) => row.body)).not.toContain(body);
    const smuggled = await announcementsForStudent(elsewhere.organizationId, world.studentId);
    expect(smuggled).toHaveLength(0);

    // And a student who has left the class stops seeing it.
    await withTenant(world.organizationId, (tx) =>
      tx.classEnrolment.updateMany({
        where: { classId: world.classId, studentUserId: world.otherStudentId },
        data: { status: "LEFT", leftAt: new Date() },
      }),
    );
    const left = await announcementsForStudent(world.organizationId, world.otherStudentId);
    expect(left.map((row) => row.body)).not.toContain(body);
    const stayed = await announcementsForStudent(world.organizationId, world.studentId);
    expect(stayed.map((row) => row.body)).toContain(body);
  });
});

describe("removing an announcement", () => {
  it("is a stamp that hides it everywhere, audited, and cannot happen twice", async () => {
    const world = await makeWorld();
    const posted = await createAnnouncement(teacherOf(world), world.classId, "Oops, wrong class.");
    if (!posted.ok) throw new Error(posted.message);

    expect((await deleteAnnouncement(teacherOf(world), posted.announcement.id)).ok).toBe(true);

    expect(
      (await announcementsForStudent(world.organizationId, world.studentId)).map((r) => r.id),
    ).not.toContain(posted.announcement.id);
    expect(
      (await listAnnouncementsForClass(world.organizationId, world.classId))!.rows.map((r) => r.id),
    ).not.toContain(posted.announcement.id);

    const row = await withTenant(world.organizationId, (tx) =>
      tx.announcement.findFirstOrThrow({ where: { id: posted.announcement.id } }),
    );
    expect(row.deletedAt).not.toBeNull();

    const audit = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.count({
        where: { action: "announcement.deleted", entityId: posted.announcement.id },
      }),
    );
    expect(audit).toBe(1);

    const again = await deleteAnnouncement(teacherOf(world), posted.announcement.id);
    expect(again.ok).toBe(false);
  });

  it("refuses a colleague who does not teach the class, and another organization", async () => {
    const world = await makeWorld();
    const elsewhere = await makeWorld();
    const posted = await createAnnouncement(teacherOf(world), world.classId, "Stays up.");
    if (!posted.ok) throw new Error(posted.message);

    const teacher = await colleague(world);
    const refused = await deleteAnnouncement(teacher, posted.announcement.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("forbidden");

    const foreign = await deleteAnnouncement(owner(elsewhere), posted.announcement.id);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toBe("not-found");

    expect(
      (await announcementsForStudent(world.organizationId, world.studentId)).map((r) => r.id),
    ).toContain(posted.announcement.id);
  });
});
