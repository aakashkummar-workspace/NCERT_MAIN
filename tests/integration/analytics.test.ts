import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { classOverview, MIN_MEASURED } from "@/core/analytics/class";
import { studentProfile } from "@/core/analytics/student";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

const actorFor = (world: World, userId: string) => ({
  organizationId: world.organizationId,
  userId,
});

/** Sits the paper answering every objective question the same way. */
async function sit(
  world: World,
  actor: { organizationId: string; userId: string },
  correct: boolean,
) {
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);

  const player = await getPlayer(actor, started.attemptId);
  const patches: AnswerPatch[] = [];
  for (const [index, question] of player!.questions.entries()) {
    if (question.type === "MCQ") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "choice", keys: [correct ? "A" : "B"] },
        clientSeq: index + 1,
      });
    } else if (question.type === "TRUE_FALSE") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "boolean", value: !correct },
        clientSeq: index + 1,
      });
    }
  }
  if (patches.length > 0) await saveAnswers(actor, started.attemptId, patches);

  await submitAttempt(actor, started.attemptId);
  return started.attemptId;
}

/** Enough sittings on one student to clear the evidence threshold. */
async function measure(
  world: World,
  actor: { organizationId: string; userId: string },
  correct: boolean,
) {
  for (let pass = 0; pass < 3; pass++) await sit(world, actor, correct);
}

describe("the class overview", () => {
  it("counts every enrolled student, measured or not", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await measure(world, studentOf(world), true);

    const overview = await classOverview(world.organizationId, world.classId);
    expect(overview?.students).toBe(2);
    // The other student has sat nothing. Their row exists and every cell is
    // INSUFFICIENT — leaving them off the grid would make a class that mostly
    // ignored the test look like a class that did well.
    expect(overview?.rows).toHaveLength(2);
    expect(overview?.unmeasuredStudents).toBe(1);

    const concept = overview!.concepts[0]!;
    expect(concept.total).toBe(2);
    expect(concept.measured).toBe(1);
    expect(concept.counts.INSUFFICIENT).toBe(1);
  });

  it("refuses a class figure drawn from too few measured students", async () => {
    // One student measured out of two. Averaging that one and printing it as
    // "the class" is arithmetically correct and a false claim.
    const world = await makeWorld({ maxAttempts: 3 });
    await measure(world, studentOf(world), true);

    const overview = await classOverview(world.organizationId, world.classId);
    const concept = overview!.concepts[0]!;

    expect(concept.measured).toBeLessThan(MIN_MEASURED);
    expect(concept.meanEstimate).toBeNull();
    expect(concept.band).toBeNull();
    // And nothing is flagged for a lesson on that basis either.
    expect(concept.needsAttention).toBe(false);
  });

  it("gives a class figure once enough students are measured", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    // Both roster students, plus a third enrolled for this test.
    await measure(world, studentOf(world), true);
    await measure(world, actorFor(world, world.otherStudentId), true);

    const third = await addStudent(world, "Third Student");
    await measure(world, actorFor(world, third), true);

    const overview = await classOverview(world.organizationId, world.classId);
    const concept = overview!.concepts[0]!;

    expect(concept.measured).toBe(MIN_MEASURED);
    expect(concept.meanEstimate).not.toBeNull();
    expect(concept.meanEstimate!).toBeGreaterThan(0.6);
    expect(concept.band).toBe(concept.meanEstimate! >= 0.8 ? "SECURE" : "DEVELOPING");
  });

  it("flags a concept most of the measured class is struggling with", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await measure(world, studentOf(world), false);
    await measure(world, actorFor(world, world.otherStudentId), false);

    const third = await addStudent(world, "Third Struggler");
    await measure(world, actorFor(world, third), false);

    const overview = await classOverview(world.organizationId, world.classId);
    const concept = overview!.concepts[0]!;

    expect(concept.struggling).toBe(3);
    expect(concept.needsAttention).toBe(true);
    expect(concept.counts.CRITICAL).toBe(3);
  });

  it("gives every student a cell for every concept, in a stable order", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await measure(world, studentOf(world), true);

    const first = await classOverview(world.organizationId, world.classId);
    const again = await classOverview(world.organizationId, world.classId);

    // A grid whose columns reshuffle between loads is a grid nobody can
    // compare across two page views.
    expect(again!.concepts.map((c) => c.conceptId)).toEqual(
      first!.concepts.map((c) => c.conceptId),
    );
    for (const row of first!.rows) {
      expect(row.cells.map((cell) => cell.conceptId)).toEqual(
        first!.concepts.map((c) => c.conceptId),
      );
    }
  });

  it("shows no other organisation's class", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    expect(await classOverview(other.organizationId, world.classId)).toBeNull();
  });
});

describe("one student, as a teacher reads them", () => {
  it("puts the sittings beside the estimate", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await measure(world, studentOf(world), true);

    const profile = await studentProfile(world.organizationId, world.studentId);
    expect(profile?.fullName).toBeTruthy();
    expect(profile?.classNames).toContain("Class 10-A");
    // Three sittings and one measured concept. Mastery without the events
    // behind it is a number a teacher cannot argue with.
    expect(profile?.sittings).toHaveLength(3);
    expect(profile?.measuredConcepts).toBe(1);
    expect(profile?.mastery[0]!.estimate).not.toBeNull();
  });

  it("reports marks still with the teacher rather than a finished score", async () => {
    const world = await makeWorld({ withWritten: true });
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const written = player!.questions.find((q) => q.type === "SA")!;
    await saveAnswers(studentOf(world), started.attemptId, [
      {
        assessmentQuestionId: written.assessmentQuestionId,
        response: { kind: "text", value: "An answer." },
        clientSeq: 1,
      },
    ]);
    await submitAttempt(studentOf(world), started.attemptId);

    const profile = await studentProfile(world.organizationId, world.studentId);
    expect(profile?.sittings[0]!.pendingMarks).toBe(3);
  });

  it("will not describe somebody who is not a student here", async () => {
    const world = await makeWorld();
    // The teacher is a real user in this organization, and still not a student.
    expect(await studentProfile(world.organizationId, world.teacherId)).toBeNull();

    const other = await makeWorld();
    expect(await studentProfile(other.organizationId, world.studentId)).toBeNull();
  });
});

/** Adds one more student to the world's class and returns their user id. */
async function addStudent(world: World, name: string): Promise<string> {
  const userId = randomUUID();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({
      data: [{ id: userId, fullName: `${name} ${userId.slice(0, 6)}`, status: "ACTIVE" }],
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
    await tx.classEnrolment.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          classId: world.classId,
          studentUserId: userId,
          status: "ACTIVE",
        },
      ],
    });
  });
  return userId;
}
