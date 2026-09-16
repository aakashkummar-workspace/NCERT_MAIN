import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { liveView } from "@/core/assignments/monitor";
import { getPlayer, saveAnswers, startAttempt, submitAttempt } from "@/core/attempts";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The live view of a paper being sat.
 *
 * Every state is derived from three stamps and the clock, so the claims worth
 * a database are: the states come out right, the order puts whoever needs the
 * invigilator first, and no mark reaches the payload.
 */

/** Start a paper and answer some of it, without submitting. */
async function beginAndAnswer(world: World, howMany: number) {
  const actor = studentOf(world);
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const player = await getPlayer(actor, started.attemptId);
  const patches = player!.questions.slice(0, howMany).map((question, index) => ({
    assessmentQuestionId: question.assessmentQuestionId,
    response: { kind: "choice" as const, keys: ["A"] },
    clientSeq: index + 1,
  }));
  if (patches.length > 0) await saveAnswers(actor, started.attemptId, patches);
  return started.attemptId;
}

describe("the states are derived, not stored", () => {
  it("shows a student who has not opened the paper as not started", async () => {
    const world = await makeWorld();
    const view = await liveView(world.organizationId, world.assignmentId);
    expect(view).not.toBeNull();
    expect(view!.counts.expected).toBeGreaterThan(0);
    expect(view!.counts.notStarted).toBe(view!.counts.expected);
    expect(view!.sittings.every((sitting) => sitting.state === "NOT_STARTED")).toBe(true);
    expect(view!.sittings.every((sitting) => sitting.startedAt === null)).toBe(true);
  });

  it("shows one writing, with time left and how far through they are", async () => {
    const world = await makeWorld();
    await beginAndAnswer(world, 1);

    const view = await liveView(world.organizationId, world.assignmentId);
    const sitting = view!.sittings.find((row) => row.studentUserId === world.studentId);
    expect(sitting?.state).toBe("IN_PROGRESS");
    expect(sitting?.answered).toBe(1);
    expect(sitting?.questionCount).toBeGreaterThan(0);
    // From the stamp, so it is positive and no larger than the paper's clock.
    expect(sitting!.timeLeftMs!).toBeGreaterThan(0);
    expect(sitting!.timeLeftMs!).toBeLessThanOrEqual(view!.durationMinutes * 60_000);
  });

  it("separates handing in from the clock running out", async () => {
    const world = await makeWorld();
    const attemptId = await beginAndAnswer(world, 1);
    await submitAttempt(studentOf(world), attemptId);

    let view = await liveView(world.organizationId, world.assignmentId);
    let sitting = view!.sittings.find((row) => row.studentUserId === world.studentId);
    expect(sitting?.state).toBe("SUBMITTED");
    expect(sitting?.submittedAt).not.toBeNull();

    // The same row, ended by the clock instead. "They pressed submit" and "it
    // ran out" are different facts about a student, and only one is a choice.
    await withTenant(world.organizationId, (tx) =>
      tx.attempt.update({ where: { id: attemptId }, data: { submitReason: "TIMEOUT" } }),
    );
    view = await liveView(world.organizationId, world.assignmentId);
    sitting = view!.sittings.find((row) => row.studentUserId === world.studentId);
    expect(sitting?.state).toBe("AUTO_SUBMITTED");
  });

  it("counts a blank as unanswered", async () => {
    const world = await makeWorld();
    await beginAndAnswer(world, 0);
    const view = await liveView(world.organizationId, world.assignmentId);
    const sitting = view!.sittings.find((row) => row.studentUserId === world.studentId);
    expect(sitting?.state).toBe("IN_PROGRESS");
    // Opening a paper is not answering it, and counting it would tell an
    // invigilator the room is further on than it is.
    expect(sitting?.answered).toBe(0);
  });
});

describe("what the payload may not contain", () => {
  it("carries no score, anywhere, for a paper being written", async () => {
    const world = await makeWorld();
    await beginAndAnswer(world, 1);

    const view = await liveView(world.organizationId, world.assignmentId);
    // The whole payload, not the fields somebody remembered to check.
    const serialised = JSON.stringify(view);
    for (const forbidden of ["rawScore", "maxScore", "percentage", "isCorrect", "awardedMarks"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("the order is whoever needs the invigilator first", () => {
  it("puts those still writing above those who have finished", async () => {
    const world = await makeWorld();
    const attemptId = await beginAndAnswer(world, 1);
    await submitAttempt(studentOf(world), attemptId);

    // The other student in the world has not started.
    const view = await liveView(world.organizationId, world.assignmentId);
    const states = view!.sittings.map((sitting) => sitting.state);
    const rank = { IN_PROGRESS: 0, NOT_STARTED: 1, AUTO_SUBMITTED: 2, SUBMITTED: 3 };
    const ranks = states.map((state) => rank[state]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe("tenancy", () => {
  it("shows one organization nothing of another's room", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    expect(await liveView(other.organizationId, world.assignmentId)).toBeNull();
  });
});
