import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import { textOf } from "@/ai/provider";
import { approveQuestion, createQuestion } from "@/core/questions";
import { assignPractice } from "@/core/practice/assigned";
import { proposePracticeFromRequest } from "@/core/practice/from-request";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, teacherOf, type World } from "./support/world";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

let mock: MockProvider;
beforeEach(() => {
  mock = new MockProvider();
  setProvider(mock);
});
afterEach(() => setProvider(null));

/**
 * Practice from a sentence. The claims worth a database: it PROPOSES and
 * writes nothing, its bank count agrees with the refusal setting would make,
 * and what it offered the model carries no id.
 */

async function stock(world: World, count: number) {
  for (let index = 0; index < count; index++) {
    const question = await createQuestion(teacherOf(world), {
      type: "MCQ",
      subjectId: world.subjectId,
      chapterId: world.chapterId,
      difficulty: "MEDIUM",
      marks: 1,
      stem: `Practice from a sentence ${index} — ${textToken()}`,
      options: [
        { key: "A", text: "The right one", isCorrect: true },
        { key: "B", text: "The wrong one", isCorrect: false },
      ],
      explanation: `Because of reason ${index}.`,
      outcomeIds: [world.outcomeId],
    });
    if (!question.ok) throw new Error("stocking failed");
    await approveQuestion(teacherOf(world), question.id);
  }
}

/** The world's concept, read and never authored — see assigned-practice.test.ts. */
async function conceptOfWorld(world: World) {
  const link = await prisma.conceptOutcome.findFirstOrThrow({
    where: { learningOutcomeId: world.outcomeId },
    select: { conceptId: true, concept: { select: { name: true } } },
  });
  return { conceptId: link.conceptId, name: link.concept.name };
}

function plan(over: Record<string, unknown> = {}) {
  return {
    kind: "ok" as const,
    value: {
      understood: true,
      note: "",
      classIndex: 0,
      conceptIndexes: [0],
      questionCount: 4,
      dueOn: null,
      studentNote: "",
      ...over,
    },
  };
}

/**
 * The index the world's concept was offered under. Two calls are made: the
 * first to read the list the model was shown, the second with the real plan.
 */
async function indexOfConcept(world: World, name: string) {
  mock.script(plan({ understood: false, note: "probe" }));
  await proposePracticeFromRequest(teacherOf(world), { request: "Practice on this idea" });
  const sent = mock.received.at(-1)!.messages.map(textOf).join("\n");
  const line = sent.split("\n").find((row) => row.endsWith(`: ${name}`));
  if (!line) throw new Error("the concept was not offered");
  return Number(line.match(/^\[(\d+)\]/)![1]);
}

describe("practice from a sentence", () => {
  it("proposes a set on the idea asked for, and writes nothing", async () => {
    const world = await makeWorld();
    await stock(world, 6);
    const concept = await conceptOfWorld(world);
    const index = await indexOfConcept(world, concept.name);

    const now = new Date("2026-09-22T04:30:00Z");
    mock.script(plan({ conceptIndexes: [index], questionCount: 5, dueOn: "2026-09-25", studentNote: "Before Thursday" }));
    const result = await proposePracticeFromRequest(teacherOf(world), { request: "Practice on this idea by Friday" }, now);
    if (!result.ok) throw new Error(result.message);

    expect(result.classId).toBe(world.classId);
    expect(result.questionCount).toBe(5);
    expect(result.dueOn).toBe("2026-09-25");
    expect(result.studentNote).toBe("Before Thursday");
    expect(result.sets).toHaveLength(1);
    expect(result.sets[0]!.conceptId).toBe(concept.conceptId);
    expect(result.sets[0]!.problem).toBeNull();
    expect(result.sets[0]!.alreadySet).toBe(false);

    const written = await withTenant(world.organizationId, (tx) =>
      tx.assignedPractice.count({ where: { classId: world.classId } }),
    );
    expect(written).toBe(0);
  });

  it("counts the bank exactly as setting it would, so the preview cannot disagree", async () => {
    const world = await makeWorld();
    const concept = await conceptOfWorld(world);
    const index = await indexOfConcept(world, concept.name);

    mock.script(plan({ conceptIndexes: [index], questionCount: 10 }));
    const result = await proposePracticeFromRequest(teacherOf(world), { request: "Ten questions on this idea" });
    if (!result.ok) throw new Error(result.message);
    const proposed = result.sets[0]!;

    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId: concept.conceptId,
      questionCount: 10,
    });
    if (proposed.available >= 10) {
      expect(proposed.problem).toBeNull();
      expect(set.ok).toBe(true);
    } else {
      // The same sentence setting refuses with.
      expect(set.ok).toBe(false);
      if (!set.ok) expect(proposed.problem).toBe(set.message);
    }
  });

  it("says when the class already has open practice on the idea, without refusing it", async () => {
    const world = await makeWorld();
    await stock(world, 6);
    const concept = await conceptOfWorld(world);
    const index = await indexOfConcept(world, concept.name);
    const first = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId: concept.conceptId,
      questionCount: 4,
    });
    expect(first.ok).toBe(true);

    mock.script(plan({ conceptIndexes: [index] }));
    const result = await proposePracticeFromRequest(teacherOf(world), { request: "Practice on this idea again" });
    if (!result.ok) throw new Error(result.message);
    expect(result.sets[0]!.alreadySet).toBe(true);
    expect(result.sets[0]!.problem).toBeNull();
  });

  it("clamps the count and drops a date that is over, and says both", async () => {
    const world = await makeWorld();
    const concept = await conceptOfWorld(world);
    const index = await indexOfConcept(world, concept.name);
    const now = new Date("2026-09-22T04:30:00Z");

    mock.script(plan({ conceptIndexes: [index], questionCount: 20, dueOn: "2026-09-21" }));
    const result = await proposePracticeFromRequest(teacherOf(world), { request: "Twenty questions by yesterday" }, now);
    if (!result.ok) throw new Error(result.message);
    expect(result.questionCount).toBe(10);
    expect(result.dueOn).toBeNull();
    expect(result.adjustments).toHaveLength(2);
  });

  it("drops an idea index that was not offered, rather than clamping it", async () => {
    const world = await makeWorld();
    mock.script(plan({ conceptIndexes: [99_999] }));
    const result = await proposePracticeFromRequest(teacherOf(world), { request: "Practice on something else" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNCLEAR");
  });

  it("offers the model names and never an id", async () => {
    const world = await makeWorld();
    const concept = await conceptOfWorld(world);
    mock.script(plan({ understood: false, note: "Which idea?" }));
    const result = await proposePracticeFromRequest(teacherOf(world), { request: "Some practice please" });
    expect(result).toEqual({ ok: false, reason: "UNCLEAR", message: "Which idea?" });
    const sent = mock.received.at(-1)!.messages.map(textOf).join("\n");
    expect(sent).toContain(concept.name);
    expect(sent).not.toContain(concept.conceptId);
    expect(sent).not.toContain(world.classId);
  });

  it("is refused to a student before anything is sent to a model", async () => {
    const world = await makeWorld();
    const result = await proposePracticeFromRequest(
      { organizationId: world.organizationId, userId: world.studentId, role: "STUDENT" },
      { request: "Practice on triangles for my class" },
    );
    expect(result.ok).toBe(false);
    expect(mock.callCount).toBe(0);
  });
});
