import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { startAttempt, submitAttempt } from "@/core/attempts";
import { teacherWorkload } from "@/core/results/workload";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * What the dashboard says is waiting on the teacher: a paper being written
 * right now, and students who cannot sign in to write one.
 */

describe("a paper being written", () => {
  it("counts who is writing apart from who has handed in", async () => {
    const world = await makeWorld();

    let workload = await teacherWorkload(world.organizationId);
    let row = workload.open.find((open) => open.assignmentId === world.assignmentId);
    expect(row).toMatchObject({ writing: 0, submitted: 0 });

    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error(started.message);
    workload = await teacherWorkload(world.organizationId);
    row = workload.open.find((open) => open.assignmentId === world.assignmentId);
    expect(row).toMatchObject({ writing: 1, submitted: 0 });

    // Handing in moves them from one count to the other, never into both.
    await submitAttempt(studentOf(world), started.attemptId);
    workload = await teacherWorkload(world.organizationId);
    row = workload.open.find((open) => open.assignmentId === world.assignmentId);
    expect(row).toMatchObject({ writing: 0, submitted: 1 });
  });

  it("carries no marks while a paper is being written", async () => {
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error(started.message);

    const serialised = JSON.stringify((await teacherWorkload(world.organizationId)).open);
    for (const forbidden of ["rawScore", "percentage", "awardedMarks", "mastery"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("students who cannot sign in", () => {
  it("names the class and counts only the students with no phone", async () => {
    const world = await makeWorld();

    // makeWorld's roster has no phone numbers: both students are counted.
    let workload = await teacherWorkload(world.organizationId);
    expect(workload.cannotSignIn).toEqual([
      { classId: world.classId, className: "Class 10-A", students: 2 },
    ]);

    // A random number, never a fixed one: phone uniqueness is global and this
    // database is never reset.
    const phone = `9${String(Math.floor(100_000_000 + Math.random() * 899_999_999))}`;
    await withTenant(world.organizationId, (tx) =>
      tx.user.update({ where: { id: world.studentId }, data: { phone } }),
    );
    workload = await teacherWorkload(world.organizationId);
    expect(workload.cannotSignIn[0]?.students).toBe(1);

    // Somebody who has left the class is not on the roster a paper goes to.
    await withTenant(world.organizationId, (tx) =>
      tx.classEnrolment.updateMany({
        where: { studentUserId: world.otherStudentId },
        data: { status: "LEFT", leftAt: new Date() },
      }),
    );
    workload = await teacherWorkload(world.organizationId);
    expect(workload.cannotSignIn).toEqual([]);
  });

  it("shows one organization nothing of another's roster", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    const workload = await teacherWorkload(other.organizationId);
    expect(workload.cannotSignIn.map((row) => row.classId)).not.toContain(world.classId);
  });
});
