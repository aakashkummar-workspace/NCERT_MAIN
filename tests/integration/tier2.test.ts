import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createAssessment, publishAssessment, publishCheck, setQuestions, updateDraft } from "@/core/assessments";
import { decideReview, requestReview, reviewQueue, setPaperReview } from "@/core/assessments/review";
import { createAssignment } from "@/core/assignments";
import { getPlayer, saveAnswers, startAttempt, submitAttempt } from "@/core/attempts";
import { reteachBrief, worksheetQuestions } from "@/core/gaps/reteach";
import { itemAnalysis } from "@/core/results";
import { setAccommodations } from "@/core/roster/accommodations";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { hours, makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/** A second staff member, so somebody other than the author can review. */
async function colleague(world: World, role: "ADMIN" | "TEACHER") {
  const userId = randomUUID();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({
      data: [{ id: userId, fullName: `Colleague ${userId.slice(0, 6)}`, status: "ACTIVE" }],
    });
    await tx.membership.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          userId,
          role,
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      ],
    });
  });
  return { organizationId: world.organizationId, userId, role };
}

async function gradeOf(world: World) {
  return (await prisma.subject.findUniqueOrThrow({ where: { id: world.subjectId } })).gradeId;
}

async function draft(world: World) {
  const created = await createAssessment(teacherOf(world), {
    title: `Reviewed ${randomUUID().slice(0, 6)}`,
    subjectId: world.subjectId,
    gradeId: await gradeOf(world),
    durationMinutes: 30,
    totalMarks: 3,
  });
  if ("error" in created) throw new Error(created.error);
  await setQuestions(teacherOf(world), created.id, world.questionIds);
  return created.id;
}

describe("a head of department reviews a paper", () => {
  it("holds publishing until someone other than the author approves it", async () => {
    const world = await makeWorld();
    await setPaperReview(teacherOf(world), true);
    const id = await draft(world);

    expect((await publishCheck(world.organizationId, id))?.ready).toBe(false);
    expect((await publishAssessment(teacherOf(world), id)).ok).toBe(false);

    expect((await requestReview(teacherOf(world), id)).ok).toBe(true);
    // The author, an owner, may not approve their own paper.
    const self = await decideReview(teacherOf(world), id, "APPROVED", null);
    expect(self.ok).toBe(false);

    const admin = await colleague(world, "ADMIN");
    const queue = await reviewQueue(admin);
    expect(queue.map((row) => row.id)).toContain(id);

    expect((await decideReview(admin, id, "APPROVED", null)).ok).toBe(true);
    expect((await publishCheck(world.organizationId, id))?.ready).toBe(true);
    expect((await publishAssessment(teacherOf(world), id)).ok).toBe(true);
  });

  it("is undone by an edit, and not by a save that changed nothing", async () => {
    const world = await makeWorld();
    await setPaperReview(teacherOf(world), true);
    const id = await draft(world);
    const admin = await colleague(world, "ADMIN");
    await requestReview(teacherOf(world), id);
    await decideReview(admin, id, "APPROVED", null);

    await setQuestions(teacherOf(world), id, world.questionIds);
    expect((await publishCheck(world.organizationId, id))?.ready).toBe(true);

    await updateDraft(teacherOf(world), id, { title: "Renamed after approval" });
    expect((await publishCheck(world.organizationId, id))?.ready).toBe(false);
  });

  it("needs a note to send a paper back, and a teacher cannot decide", async () => {
    const world = await makeWorld();
    await setPaperReview(teacherOf(world), true);
    const id = await draft(world);
    await requestReview(teacherOf(world), id);
    const admin = await colleague(world, "ADMIN");
    const teacher = await colleague(world, "TEACHER");

    expect((await decideReview(admin, id, "CHANGES_REQUESTED", "  ")).ok).toBe(false);
    expect((await decideReview(teacher, id, "APPROVED", null)).ok).toBe(false);
    expect((await decideReview(admin, id, "CHANGES_REQUESTED", "Question 2 has two right answers.")).ok).toBe(true);
    const problems = (await publishCheck(world.organizationId, id))?.problems ?? [];
    expect(problems.join(" ")).toMatch(/asked for changes/);
  });

  it("changes nothing for a school that has not turned it on", async () => {
    const world = await makeWorld();
    const id = await draft(world);
    expect((await publishCheck(world.organizationId, id))?.ready).toBe(true);
  });
});

describe("extra time", () => {
  it("lengthens the student's own clock, and nobody else's", async () => {
    const world = await makeWorld();
    await setAccommodations(teacherOf(world), world.studentId, { extraTimePercent: 50, readAloud: true });

    const mine = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    const theirs = await startAttempt(
      { organizationId: world.organizationId, userId: world.otherStudentId },
      world.assignmentId,
      randomUUID(),
    );
    if (!mine.ok || !theirs.ok) throw new Error("could not start");
    const [a, b] = await withTenant(world.organizationId, (tx) =>
      Promise.all([
        tx.attempt.findUniqueOrThrow({ where: { id: mine.attemptId } }),
        tx.attempt.findUniqueOrThrow({ where: { id: theirs.attemptId } }),
      ]),
    );
    // The world's paper is 45 minutes.
    expect(Math.round(a.durationMs / 60_000)).toBe(68);
    expect(Math.round(b.durationMs / 60_000)).toBe(45);

    const player = await getPlayer(studentOf(world), mine.attemptId);
    expect(player?.readAloud).toBe(true);
  });

  it("refuses a window too short for a student who has it", async () => {
    const world = await makeWorld();
    await setAccommodations(teacherOf(world), world.studentId, { extraTimePercent: 33, readAloud: false });
    const online = await withTenant(world.organizationId, (tx) =>
      tx.assignment.findUniqueOrThrow({ where: { id: world.assignmentId } }),
    );
    const opensAt = new Date(Date.now() + hours(1));
    const tooShort = await createAssignment(teacherOf(world), {
      assessmentId: online.assessmentId,
      classId: world.classId,
      opensAt,
      closesAt: new Date(opensAt.getTime() + 50 * 60_000),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok) expect(tooShort.message).toMatch(/extra time and would need 60 minutes/);

    const longEnough = await createAssignment(teacherOf(world), {
      assessmentId: online.assessmentId,
      classId: world.classId,
      opensAt,
      closesAt: new Date(opensAt.getTime() + 60 * 60_000),
      maxAttempts: 1,
      resultsPolicy: "AFTER_CLOSE",
    });
    expect(longEnough.ok).toBe(true);
  });

  it("is refused outside the menu", async () => {
    const world = await makeWorld();
    const result = await setAccommodations(teacherOf(world), world.studentId, {
      extraTimePercent: 200,
      readAloud: false,
    });
    expect(result.ok).toBe(false);
  });
});

describe("what the class chose, and the reteach brief", () => {
  /** Both students answer the world's MCQ with the same wrong option. */
  async function sameWrongAnswer(world: World) {
    for (const actor of [studentOf(world), { organizationId: world.organizationId, userId: world.otherStudentId }]) {
      const started = await startAttempt(actor, world.assignmentId, randomUUID());
      if (!started.ok) throw new Error(started.message);
      const player = (await getPlayer(actor, started.attemptId))!;
      const mcq = player.questions.find((q) => q.type === "MCQ")!;
      await saveAnswers(actor, started.attemptId, [
        { assessmentQuestionId: mcq.assessmentQuestionId, response: { kind: "choice", keys: ["B"] }, clientSeq: 1 },
      ]);
      await submitAttempt(actor, started.attemptId);
    }
  }

  it("names who chose a shared wrong answer on the results page", async () => {
    const world = await makeWorld();
    await sameWrongAnswer(world);
    const analysis = await itemAnalysis(world.organizationId, world.assignmentId);
    const mcq = analysis!.items.find((item) => item.type === "MCQ")!;
    expect(mcq.sharedWrong).toHaveLength(1);
    expect(mcq.sharedWrong[0]).toMatchObject({ key: "B", chosen: 2 });
    expect(mcq.sharedWrong[0]!.names).toHaveLength(2);
  });

  it("builds a brief from the class's own wrong answers, with a worksheet", async () => {
    const world = await makeWorld();
    await sameWrongAnswer(world);
    const link = await prisma.conceptOutcome.findFirstOrThrow({
      where: { learningOutcomeId: world.outcomeId },
    });
    const gap = await withTenant(world.organizationId, async (tx) => {
      const existing = await tx.learningGap.findFirst({
        where: { scope: "CLASS", scopeId: world.classId, conceptId: link.conceptId },
      });
      if (existing) return existing;
      return tx.learningGap.create({
        data: {
          organizationId: world.organizationId,
          scope: "CLASS",
          scopeId: world.classId,
          conceptId: link.conceptId,
          severity: "HIGH",
          affectedStudentCount: 2,
          meanEstimate: 0.3,
          measuredStudentCount: 2,
        },
      });
    });

    const brief = await reteachBrief(world.organizationId, gap.id);
    expect(brief).not.toBeNull();
    expect(brief!.outcomes.length).toBeGreaterThan(0);
    const shared = brief!.misconceptions.find((m) => m.chosen.key === "B");
    expect(shared?.students).toBe(2);
    expect(brief!.worksheetIds.length).toBeGreaterThan(0);

    const sheet = await worksheetQuestions(world.organizationId, link.conceptId, brief!.worksheetIds);
    expect(sheet.length).toBe(brief!.worksheetIds.length);
    // An id that is not on this concept is dropped, not printed.
    const foreign = await worksheetQuestions(world.organizationId, link.conceptId, [randomUUID()]);
    expect(foreign).toHaveLength(0);
  });
});
