import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { listStudents } from "@/core/analytics/students";
import { classPapers } from "@/core/assignments/class-papers";
import { startAttempt, submitAttempt } from "@/core/attempts";
import { prisma } from "@/db/client";
import { makeWorld, studentOf } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The class page: the papers set for one class, and what is known about each
 * student on its roster.
 */

describe("the papers set for a class", () => {
  it("lists the class's paper with who has handed in and who is writing", async () => {
    const world = await makeWorld();

    let result = await classPapers(world.organizationId, world.classId);
    expect(result.total).toBe(1);
    expect(result.papers[0]).toMatchObject({
      assignmentId: world.assignmentId,
      status: "OPEN",
      expected: 2,
      handedIn: 0,
      writing: 0,
      answersToMark: 0,
      resultsReleasedAt: null,
    });

    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error(started.message);
    result = await classPapers(world.organizationId, world.classId);
    expect(result.papers[0]).toMatchObject({ handedIn: 0, writing: 1 });

    await submitAttempt(studentOf(world), started.attemptId);
    result = await classPapers(world.organizationId, world.classId);
    expect(result.papers[0]).toMatchObject({ handedIn: 1, writing: 0 });
  });

  it("carries no marks", async () => {
    const world = await makeWorld();
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error(started.message);
    await submitAttempt(studentOf(world), started.attemptId);

    const serialised = JSON.stringify(await classPapers(world.organizationId, world.classId));
    for (const forbidden of ["rawScore", "percentage", "awardedMarks", "average", "mastery"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("shows one organization nothing of another's class", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    const result = await classPapers(other.organizationId, world.classId);
    expect(result).toEqual({ papers: [], total: 0 });
  });
});

describe("the roster's learning status", () => {
  it("narrows to the roster it is given", async () => {
    const world = await makeWorld();
    const rows = await listStudents(world.organizationId, [world.studentId]);
    expect(rows.map((row) => row.studentUserId)).toEqual([world.studentId]);
    // Nothing marked yet: a denominator of zero, not a score of zero.
    expect(rows[0]).toMatchObject({ measuredConcepts: 0, weakest: null });
  });

  it("returns nobody for an empty roster, rather than the whole school", async () => {
    const world = await makeWorld();
    expect(await listStudents(world.organizationId, [])).toEqual([]);
  });

  it("will not return another organization's student by id", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    expect(await listStudents(other.organizationId, [world.studentId])).toEqual([]);
  });
});
