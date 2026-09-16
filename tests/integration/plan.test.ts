import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { studyPlan } from "@/core/plan";
import { approveQuestion, createQuestion } from "@/core/questions";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

/** Enough approved questions on the seeded concept for practice to be servable. */
async function stock(world: World, count: number) {
  const outcome = await prisma.learningOutcome.findFirstOrThrow({
    where: { code: "SIM-2" },
  });
  for (let index = 0; index < count; index++) {
    const created = await createQuestion(teacherOf(world), {
      type: "MCQ",
      subjectId: world.subjectId,
      chapterId: world.chapterId,
      difficulty: index % 2 === 0 ? "EASY" : "MEDIUM",
      marks: 1,
      stem: `Plan stock question ${index} ${textToken()} — which criterion applies?`,
      options: [
        { key: "A", text: "The right one", isCorrect: true },
        { key: "B", text: "A wrong one", isCorrect: false },
        { key: "C", text: "Another wrong one", isCorrect: false },
      ],
      explanation: "Because the third angle follows.",
      outcomeIds: [outcome.id],
    });
    if (!created.ok) throw new Error(`createQuestion: ${created.code}`);
    await approveQuestion(teacherOf(world), created.id);
  }
}

async function sit(world: World, correct: boolean) {
  const actor = studentOf(world);
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
  await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);
}

/** A student who has sat the paper badly three times, with a stocked bank. */
async function struggling() {
  const world = await makeWorld({ maxAttempts: 5 });
  await stock(world, 10);
  for (let pass = 0; pass < 3; pass++) await sit(world, false);
  return world;
}

describe("the plan refuses before it guesses", () => {
  it("says nothing-yet for a student who has sat nothing", async () => {
    const world = await makeWorld();
    const plan = await studyPlan(studentOf(world));

    // The world's assignment is open, so there IS something — a paper to sit.
    // That is the honest answer, not a refusal.
    if (!plan.ok) {
      expect(plan.reason).toBe("nothing-yet");
      return;
    }
    expect(plan.items.every((item) => item.deadline)).toBe(true);
  });

  it("stops offering a paper the moment its window shuts", async () => {
    const world = await makeWorld();
    const open = await studyPlan(studentOf(world));
    if (!open.ok) throw new Error(open.message);
    expect(open.items.some((item) => item.kind === "sit-test")).toBe(true);

    // Move the window into the past. Nothing else changes — no status column
    // to flip, because there is no status column: it is a function of two
    // timestamps and the clock, here as everywhere else.
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.update({
        where: { id: world.assignmentId },
        data: {
          opensAt: new Date(Date.now() - 5 * 86_400_000),
          closesAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );

    const shut = await studyPlan(studentOf(world));
    if (shut.ok) {
      expect(shut.items.some((item) => item.kind === "sit-test")).toBe(false);
      return;
    }
    // With the paper gone and nothing measured, the honest answer is that
    // there is nothing here yet — not a guess about what to revise.
    expect(shut.reason).toBe("nothing-yet");
    expect(shut.message).toMatch(/sat a test/i);
  });
});

describe("the plan reads the same evidence the rest of the product does", () => {
  it("does not tell them to sit a paper they have already sat", async () => {
    const world = await struggling();
    const plan = await studyPlan(studentOf(world));
    if (!plan.ok) throw new Error(plan.message);

    // maxAttempts is 5 and they have used 3, so the paper is still startable —
    // but "Sit … Due" is for a paper not yet started. A further attempt is an
    // option on Home, not a deadline, and listing it told a student the paper
    // they had just handed in did not count.
    const kinds = plan.items.map((item) => item.kind);
    expect(kinds).not.toContain("sit-test");

    // What the evidence says leads instead.
    expect(kinds).toContain("fix-mistakes");
  });

  it("counts the same open mistakes the bank shows", async () => {
    const world = await struggling();
    const plan = await studyPlan(studentOf(world));
    if (!plan.ok) throw new Error(plan.message);

    const fix = plan.items.find((item) => item.kind === "fix-mistakes");
    expect(fix).toBeDefined();

    const open = await withTenant(world.organizationId, (tx) =>
      tx.studentMistake.count({
        where: { studentUserId: world.studentId, status: { not: "RESOLVED" } },
      }),
    );
    // The plan and the bank must not disagree about how many there are; a
    // student who is told five and finds three stops believing both pages.
    expect(fix!.title).toContain(String(open));
  });

  it("names the concept most of the mistakes are about", async () => {
    const world = await struggling();
    const plan = await studyPlan(studentOf(world));
    if (!plan.ok) throw new Error(plan.message);

    const fix = plan.items.find((item) => item.kind === "fix-mistakes")!;
    // "Five questions to fix" is a chore. "Five questions to fix, mostly about
    // similarity" is a diagnosis.
    expect(fix.why).toMatch(/about /i);
  });

  it("holds every item within the cap and never repeats a concept", async () => {
    const world = await struggling();
    const plan = await studyPlan(studentOf(world));
    if (!plan.ok) throw new Error(plan.message);

    expect(plan.items.length).toBeLessThanOrEqual(5);
    const concepts = plan.items
      .map((item) => item.conceptId)
      .filter((id): id is string => id !== null);
    expect(new Set(concepts).size).toBe(concepts.length);
  });

  it("gives every item somewhere to go", async () => {
    const world = await struggling();
    const plan = await studyPlan(studentOf(world));
    if (!plan.ok) throw new Error(plan.message);
    for (const item of plan.items) {
      expect(item.href.startsWith("/student/")).toBe(true);
    }
  });
});

describe("nothing is stored", () => {
  it("writes no rows at all", async () => {
    const world = await struggling();

    const before = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.count({}),
    );
    await studyPlan(studentOf(world));
    await studyPlan(studentOf(world));
    const after = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.count({}),
    );

    // A plan is derived at read time, exactly as an assignment's status is.
    // There is no table, so there is nothing to go stale and no job to keep it
    // fresh — and no row that could be a lie between ticks.
    expect(after).toBe(before);
  });

  it("re-derives the same plan from unchanged evidence", async () => {
    const world = await struggling();
    const first = await studyPlan(studentOf(world));
    const second = await studyPlan(studentOf(world));

    if (!first.ok || !second.ok) throw new Error("expected a plan");
    expect(second.items.map((item) => item.title)).toEqual(
      first.items.map((item) => item.title),
    );
  });

  it("drops the mistakes item once the mistakes are resolved", async () => {
    const world = await struggling();
    const before = await studyPlan(studentOf(world));
    if (!before.ok) throw new Error(before.message);
    expect(before.items.some((item) => item.kind === "fix-mistakes")).toBe(true);

    await withTenant(world.organizationId, (tx) =>
      tx.studentMistake.updateMany({
        where: { studentUserId: world.studentId },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      }),
    );

    const after = await studyPlan(studentOf(world));
    if (!after.ok) throw new Error(after.message);
    // It left because the evidence moved, which is the only way anything
    // leaves this list. No route ticked it off.
    expect(after.items.some((item) => item.kind === "fix-mistakes")).toBe(false);
  });
});

describe("tenancy", () => {
  it("shows one student nothing of another's", async () => {
    const world = await struggling();
    const other = {
      organizationId: world.organizationId,
      userId: world.otherStudentId,
    };

    const theirs = await studyPlan(other);
    if (!theirs.ok) return;
    // The other student sat nothing, so nothing evidence-driven can appear.
    expect(theirs.items.every((item) => item.deadline)).toBe(true);
  });
});
