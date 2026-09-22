import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import { textOf } from "@/ai/provider";
import { draftPaperFromRequest } from "@/core/assessments/from-request";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, teacherOf } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

let mock: MockProvider;
beforeEach(() => {
  mock = new MockProvider();
  setProvider(mock);
});
afterEach(() => setProvider(null));

/** A plan as the model would return it. Every chapter offered, so the class's own is among them. */
function plan(over: Record<string, unknown> = {}) {
  return {
    kind: "ok" as const,
    value: {
      understood: true,
      note: "",
      classIndex: 0,
      title: "Triangles — class test",
      chapterIndexes: Array.from({ length: 20 }, (_, index) => index),
      shape: "CUSTOM",
      questionCount: 10,
      typeMix: [{ type: "MCQ", percent: 100 }],
      difficulty: { easy: 50, medium: 50, hard: 0 },
      durationMinutes: 30,
      opensOn: null,
      closesOn: null,
      ...over,
    },
  };
}

describe("a paper from a sentence", () => {
  it("builds a DRAFT from the school's own approved questions, and neither publishes nor assigns it", async () => {
    const world = await makeWorld();
    mock.script(plan());

    const result = await draftPaperFromRequest(teacherOf(world), { request: "A 10-question MCQ test on Triangles" });
    if (!result.ok) throw new Error(result.message);
    expect(result.classId).toBe(world.classId);

    const assessment = await withTenant(world.organizationId, (tx) =>
      tx.assessment.findUniqueOrThrow({
        where: { id: result.assessmentId },
        include: { questions: true, assignments: true },
      }),
    );
    expect(assessment.status).toBe("DRAFT");
    expect(assessment.assignments).toHaveLength(0);
    expect(assessment.classId).toBe(world.classId);
    // Only this school's approved questions, and the marks add up — the rule
    // publishing checks, so the draft can be published as it stands.
    const approved = await withTenant(world.organizationId, (tx) =>
      tx.question.findMany({ where: { status: "APPROVED", deletedAt: null }, select: { id: true, marks: true } }),
    );
    const approvedIds = new Set(approved.map((q) => q.id));
    expect(assessment.questions.length).toBeGreaterThan(0);
    expect(assessment.questions.every((row) => approvedIds.has(row.questionId))).toBe(true);
    const marks = assessment.questions.reduce(
      (sum, row) => sum + (approved.find((q) => q.id === row.questionId)?.marks ?? 0),
      0,
    );
    expect(assessment.totalMarks).toBe(marks);
    // The world's bank holds two questions; ten were asked for, and that is said.
    expect(result.shortfalls.length).toBeGreaterThan(0);
  });

  it("offers only this teacher's own classes and never another school's", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    mock.script(plan());
    await draftPaperFromRequest(teacherOf(world), { request: "A short test on Triangles" });
    const sent = mock.received.at(-1)!.messages.map(textOf).join("\n");
    const otherClass = await withTenant(other.organizationId, (tx) =>
      tx.class.findUniqueOrThrow({ where: { id: other.classId } }),
    );
    const mine = await withTenant(world.organizationId, (tx) =>
      tx.class.findUniqueOrThrow({ where: { id: world.classId } }),
    );
    expect(sent).toContain(mine.name);
    // Class names can coincide across schools, so the check is on the id.
    expect(sent).not.toContain(otherClass.id);
    expect(sent).not.toContain(world.classId);
  });

  it("builds nothing when the model could not read the request as a paper", async () => {
    const world = await makeWorld();
    mock.script(plan({ understood: false, note: "Which class is this paper for?" }));
    const before = await withTenant(world.organizationId, (tx) => tx.assessment.count());
    const result = await draftPaperFromRequest(teacherOf(world), { request: "make something nice please" });
    expect(result).toEqual({ ok: false, reason: "UNCLEAR", message: "Which class is this paper for?" });
    expect(await withTenant(world.organizationId, (tx) => tx.assessment.count())).toBe(before);
  });

  it("drops a class index that was not offered, rather than clamping it", async () => {
    const world = await makeWorld();
    mock.script(plan({ classIndex: 7 }));
    const result = await draftPaperFromRequest(teacherOf(world), { request: "A test on Triangles for 10-Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNCLEAR");
  });

  it("offers the window asked for, and applies none of it", async () => {
    const world = await makeWorld();
    // Tuesday 22 September 2026, 10:00 IST; "due Friday".
    const now = new Date("2026-09-22T04:30:00Z");
    mock.script(plan({ closesOn: "2026-09-25" }));
    const result = await draftPaperFromRequest(teacherOf(world), { request: "Triangles test due Friday" }, now);
    if (!result.ok) throw new Error(result.message);
    expect(result.window).toEqual({ opensAt: now.toISOString(), closesAt: "2026-09-25T14:30:00.000Z" });
    const assignments = await withTenant(world.organizationId, (tx) =>
      tx.assignment.count({ where: { assessmentId: result.assessmentId } }),
    );
    expect(assignments).toBe(0);
  });

  it("is refused to a student before anything is sent to a model", async () => {
    const world = await makeWorld();
    const result = await draftPaperFromRequest(
      { organizationId: world.organizationId, userId: world.studentId, role: "STUDENT" },
      { request: "A test on Triangles for my class" },
    );
    expect(result.ok).toBe(false);
    expect(mock.callCount).toBe(0);
  });
});
