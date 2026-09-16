import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { joinClassByCode } from "@/core/roster/join";
import { rotateJoinCode } from "@/core/classes";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

async function codeFor(world: World): Promise<string> {
  const klass = await withTenant(world.organizationId, (tx) =>
    tx.class.findUniqueOrThrow({ where: { id: world.classId } }),
  );
  return klass.joinCode ?? (await rotateJoinCode(teacherOf(world), world.classId));
}

/** A student of this organization who is in no class. */
async function loneStudent(world: World): Promise<string> {
  const userId = randomUUID();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({
      data: [{ id: userId, fullName: `Newcomer ${userId.slice(0, 6)}`, status: "ACTIVE" }],
    });
    await tx.membership.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          userId,
          role: "STUDENT",
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      ],
    });
  });
  return userId;
}

describe("joining a class with a code", () => {
  it("puts the student in the class", async () => {
    const world = await makeWorld();
    const userId = await loneStudent(world);
    const code = await codeFor(world);

    const result = await joinClassByCode(
      { organizationId: world.organizationId, userId },
      code,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.classId).toBe(world.classId);
    expect(result.alreadyIn).toBe(false);

    const enrolment = await withTenant(world.organizationId, (tx) =>
      tx.classEnrolment.findFirst({
        where: { classId: world.classId, studentUserId: userId },
      }),
    );
    expect(enrolment?.status).toBe("ACTIVE");
  });

  it("forgives case and stray spaces", async () => {
    // The code is read aloud in a classroom and typed on a phone. Case is the
    // student's environment, not their mistake.
    const world = await makeWorld();
    const userId = await loneStudent(world);
    const code = await codeFor(world);

    const result = await joinClassByCode(
      { organizationId: world.organizationId, userId },
      ` ${code.toLowerCase()} `,
    );
    expect(result.ok).toBe(true);
  });

  it("is not an error to join twice", async () => {
    // A student who taps join twice, or who was already added by their
    // teacher, has done nothing wrong and should land in the class either way.
    const world = await makeWorld();
    const code = await codeFor(world);

    const again = await joinClassByCode(studentOf(world), code);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyIn).toBe(true);

    const enrolments = await withTenant(world.organizationId, (tx) =>
      tx.classEnrolment.findMany({
        where: { classId: world.classId, studentUserId: world.studentId },
      }),
    );
    expect(enrolments).toHaveLength(1);
  });

  it("brings back a student who had left", async () => {
    const world = await makeWorld();
    const code = await codeFor(world);

    await withTenant(world.organizationId, (tx) =>
      tx.classEnrolment.updateMany({
        where: { classId: world.classId, studentUserId: world.studentId },
        data: { status: "REMOVED", leftAt: new Date() },
      }),
    );

    const result = await joinClassByCode(studentOf(world), code);
    expect(result.ok).toBe(true);

    const enrolment = await withTenant(world.organizationId, (tx) =>
      tx.classEnrolment.findFirst({
        where: { classId: world.classId, studentUserId: world.studentId },
      }),
    );
    expect(enrolment?.status).toBe("ACTIVE");
    expect(enrolment?.leftAt).toBeNull();
  });
});

describe("what a code cannot do", () => {
  it("refuses a code from another organisation, and says nothing about it", async () => {
    // The same answer as a wrong code and as a rotated one. Distinguishing them
    // would turn the form into a way of testing whether a code is live
    // somewhere on the platform.
    const world = await makeWorld();
    const other = await makeWorld();
    const code = await codeFor(other);

    const result = await joinClassByCode(studentOf(world), code);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("No class here uses that code.");
  });

  it("refuses a code that has been rotated", async () => {
    const world = await makeWorld();
    const userId = await loneStudent(world);
    const old = await codeFor(world);
    await rotateJoinCode(teacherOf(world), world.classId);

    const result = await joinClassByCode(
      { organizationId: world.organizationId, userId },
      old,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("No class here uses that code.");
  });

  it("refuses an archived class", async () => {
    const world = await makeWorld();
    const userId = await loneStudent(world);
    const code = await codeFor(world);

    await withTenant(world.organizationId, (tx) =>
      tx.class.updateMany({ where: { id: world.classId }, data: { status: "ARCHIVED" } }),
    );

    const result = await joinClassByCode(
      { organizationId: world.organizationId, userId },
      code,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("archived");
  });

  it("refuses something that is not a code at all", async () => {
    const world = await makeWorld();
    const userId = await loneStudent(world);
    for (const nonsense of ["", "  ", "AB"]) {
      const result = await joinClassByCode(
        { organizationId: world.organizationId, userId },
        nonsense,
      );
      expect(result.ok).toBe(false);
    }
  });
});
