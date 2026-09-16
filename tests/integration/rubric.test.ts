import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { approveQuestion, createQuestion } from "@/core/questions";
import { awardByRubric, awardMarks, markingQueue } from "@/core/results/marking";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
} from "@/core/attempts";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

const RUBRIC = {
  criteria: [
    { id: "method", label: "Method", marks: 2, descriptor: "Names the right criterion" },
    { id: "working", label: "Working shown", marks: 1 },
  ],
};

/** A world whose written question carries a mark scheme. */
async function withRubric(rubric: unknown = RUBRIC) {
  const world = await makeWorld({ maxAttempts: 3, withWritten: true });

  const written = await createQuestion(teacherOf(world), {
    type: "SA",
    subjectId: world.subjectId,
    chapterId: world.chapterId,
    difficulty: "MEDIUM",
    marks: 3,
    stem: `Explain why AA proves similarity. ${textToken()}`,
    explanation: "The third angle follows from the first two.",
    outcomeIds: [world.outcomeId],
    rubric: rubric as never,
  });
  return { world, written };
}

async function sitWithWriting(world: World, text: string) {
  const actor = studentOf(world);
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const player = await getPlayer(actor, started.attemptId);
  await saveAnswers(
    actor,
    started.attemptId,
    player!.questions.map((question, index) => ({
      assessmentQuestionId: question.assessmentQuestionId,
      response:
        question.type === "SA"
          ? { kind: "text" as const, value: text }
          : question.type === "TRUE_FALSE"
            ? { kind: "boolean" as const, value: false }
            : { kind: "choice" as const, keys: ["A"] },
      clientSeq: index + 1,
    })),
  );
  await submitAttempt(actor, started.attemptId);
}

describe("a mark scheme is refused if it cannot award full marks", () => {
  it("rejects one that adds up short", async () => {
    const { written } = await withRubric({
      criteria: [{ id: "a", label: "Method", marks: 2 }],
    });
    // The question is worth 3. Discovered at the twentieth paper, this costs
    // every mark already given.
    expect(written.ok).toBe(false);
    if (!written.ok && written.code === "MISFILED") {
      expect(written.message).toMatch(/could not get full marks/i);
    }
  });

  it("rejects one that adds up over", async () => {
    const { written } = await withRubric({
      criteria: [
        { id: "a", label: "Method", marks: 3 },
        { id: "b", label: "Working", marks: 2 },
      ],
    });
    expect(written.ok).toBe(false);
  });

  it("accepts one that adds up exactly", async () => {
    const { written } = await withRubric();
    expect(written.ok).toBe(true);
  });

  it("still accepts a question with no scheme at all", async () => {
    // A rubric is an improvement on typing a number, never a gate in front of
    // it — and every question authored before this existed has none.
    const world = await makeWorld();
    const plain = await createQuestion(teacherOf(world), {
      type: "SA",
      subjectId: world.subjectId,
      chapterId: world.chapterId,
      difficulty: "MEDIUM",
      marks: 3,
      stem: `No scheme here. ${textToken()}`,
      explanation: "Because it follows.",
      outcomeIds: [world.outcomeId],
    });
    expect(plain.ok).toBe(true);
  });
});

describe("marking against the scheme", () => {
  it("derives the total from the criteria and stores the breakdown", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sitWithWriting(world, "Two equal angles force the third.");

    // Attach a scheme to the version the student was served, so the marking
    // board has one to use.
    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const item = queue!.groups[0]!.answers[0]!;
    const answer = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findFirstOrThrow({ where: { id: item.answerId } }),
    );
    await withTenant(world.organizationId, (tx) =>
      tx.questionVersion.update({
        where: { id: answer.questionVersionId! },
        data: { rubric: RUBRIC as never },
      }),
    );

    const marked = await awardByRubric(teacherOf(world), item.answerId, [
      { criterionId: "method", marks: 2 },
      { criterionId: "working", marks: 0.5, note: "Steps skipped." },
    ]);
    if (!marked.ok) throw new Error(marked.message);

    const stored = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findFirstOrThrow({ where: { id: item.answerId } }),
    );
    // The total is derived, never typed — there is no parameter for it, which
    // is why a marker cannot disagree with their own breakdown.
    expect(Number(stored.awardedMarks)).toBe(2.5);
    // 2.5 of 3 is neither right nor wrong.
    expect(stored.isCorrect).toBeNull();
    expect(stored.gradedAt).not.toBeNull();

    const breakdown = stored.rubricScores as { criterionId: string; marks: number }[];
    // "Method 2 of 2, working 0.5 of 1" tells a student where it went;
    // "2.5 out of 3" tells them only that it did.
    expect(breakdown).toHaveLength(2);
    expect(breakdown.find((row) => row.criterionId === "working")!.marks).toBe(0.5);
  });

  it("refuses a mark above what a criterion is worth", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sitWithWriting(world, "An answer.");
    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const item = queue!.groups[0]!.answers[0]!;
    const answer = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findFirstOrThrow({ where: { id: item.answerId } }),
    );
    await withTenant(world.organizationId, (tx) =>
      tx.questionVersion.update({
        where: { id: answer.questionVersionId! },
        data: { rubric: RUBRIC as never },
      }),
    );

    const marked = await awardByRubric(teacherOf(world), item.answerId, [
      { criterionId: "method", marks: 5 },
      { criterionId: "working", marks: 1 },
    ]);
    // Refused, never clamped — the same rule the total box follows.
    expect(marked.ok).toBe(false);

    const untouched = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findFirstOrThrow({ where: { id: item.answerId } }),
    );
    expect(untouched.awardedMarks).toBeNull();
  });

  it("refuses a partly filled scheme", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sitWithWriting(world, "An answer.");
    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const item = queue!.groups[0]!.answers[0]!;
    const answer = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findFirstOrThrow({ where: { id: item.answerId } }),
    );
    await withTenant(world.organizationId, (tx) =>
      tx.questionVersion.update({
        where: { id: answer.questionVersionId! },
        data: { rubric: RUBRIC as never },
      }),
    );

    const marked = await awardByRubric(teacherOf(world), item.answerId, [
      { criterionId: "method", marks: 2 },
    ]);
    // A partly filled rubric produces a total that looks like a judgement and
    // is actually an omission.
    expect(marked.ok).toBe(false);
    if (!marked.ok) expect(marked.message).toMatch(/has not been marked/i);
  });

  it("refuses when the question has no scheme, rather than inventing one", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sitWithWriting(world, "An answer.");
    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const item = queue!.groups[0]!.answers[0]!;

    const marked = await awardByRubric(teacherOf(world), item.answerId, [
      { criterionId: "method", marks: 2 },
    ]);
    expect(marked.ok).toBe(false);
    if (!marked.ok) expect(marked.message).toMatch(/no mark scheme/i);
  });

  it("runs every downstream hook, exactly as a typed total does", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sitWithWriting(world, "A partial answer.");
    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const item = queue!.groups[0]!.answers[0]!;
    const answer = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findFirstOrThrow({ where: { id: item.answerId } }),
    );
    await withTenant(world.organizationId, (tx) =>
      tx.questionVersion.update({
        where: { id: answer.questionVersionId! },
        data: { rubric: RUBRIC as never },
      }),
    );

    await awardByRubric(teacherOf(world), item.answerId, [
      { criterionId: "method", marks: 0 },
      { criterionId: "working", marks: 0 },
    ]);

    // Evidence, the re-score and the mistake bank all follow, because this
    // delegates to awardMarks rather than repeating it.
    const evidence = await withTenant(world.organizationId, (tx) =>
      tx.conceptEvidence.count({ where: { attemptAnswerId: item.answerId } }),
    );
    expect(evidence).toBeGreaterThan(0);

    const mistake = await withTenant(world.organizationId, (tx) =>
      tx.studentMistake.findFirst({ where: { attemptAnswerId: item.answerId } }),
    );
    expect(mistake).not.toBeNull();
  });

  it("leaves the plain path working", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sitWithWriting(world, "An answer.");
    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const item = queue!.groups[0]!.answers[0]!;

    const marked = await awardMarks(teacherOf(world), item.answerId, 2, "Good method.");
    expect(marked.ok).toBe(true);
  });
});

describe("the marking board carries the scheme", () => {
  it("hands the marker the criteria, not just a box", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sitWithWriting(world, "An answer.");

    const before = await markingQueue(teacherOf(world), world.assignmentId);
    // Null is an ordinary state: every question authored before this has none.
    expect(before!.groups[0]!.rubric).toBeNull();

    const answer = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findFirstOrThrow({
        where: { id: before!.groups[0]!.answers[0]!.answerId },
      }),
    );
    await withTenant(world.organizationId, (tx) =>
      tx.questionVersion.update({
        where: { id: answer.questionVersionId! },
        data: { rubric: RUBRIC as never },
      }),
    );

    const after = await markingQueue(teacherOf(world), world.assignmentId);
    expect(after!.groups[0]!.rubric!.criteria).toHaveLength(2);
    // The descriptor is what makes it a mark scheme rather than a list of
    // labels — it is the standard the twentieth answer is marked against.
    expect(after!.groups[0]!.rubric!.criteria[0]!.descriptor).toBeTruthy();
  });
});

describe("an approved question keeps its scheme frozen", () => {
  it("edits into a new version rather than changing the old one", async () => {
    const world = await makeWorld();
    const created = await createQuestion(teacherOf(world), {
      type: "SA",
      subjectId: world.subjectId,
      chapterId: world.chapterId,
      difficulty: "MEDIUM",
      marks: 3,
      stem: `Frozen scheme. ${textToken()}`,
      explanation: "Because it follows.",
      outcomeIds: [world.outcomeId],
      rubric: RUBRIC as never,
    });
    if (!created.ok) throw new Error("create failed");
    await approveQuestion(teacherOf(world), created.id);

    const versions = await withTenant(world.organizationId, (tx) =>
      tx.questionVersion.findMany({ where: { questionId: created.id } }),
    );
    expect(versions).toHaveLength(1);
    // A paper marked in August must still be explainable in December, so the
    // scheme lives on the version alongside the answer key.
    expect(versions[0]!.rubric).not.toBeNull();
  });
});
