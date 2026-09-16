import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import { createClass } from "@/core/classes";
import { approveQuestion, createQuestion } from "@/core/questions";
import {
  bankInventory,
  checkFeasibility,
  closeAssessment,
  createAssessment,
  duplicateAssessment,
  getAssessment,
  listAssessments,
  publishAssessment,
  publishCheck,
  setQuestions,
  updateDraft,
  DEFAULT_BLUEPRINT,
} from "@/core/assessments";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

type Ctx = {
  organizationId: string;
  userId: string;
  role: string;
  subjectId: string;
  gradeId: string;
  chapterId: string;
  outcomeId: string;
};

async function makeOrg(): Promise<Ctx> {
  const result = await signUp({
    fullName: "Author",
    email: `a-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Assessment Org",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!result.ok) throw new Error("signUp failed");

  const membership = await withTenant(result.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );

  const outcome = await prisma.learningOutcome.findFirstOrThrow({
    where: { code: "SIM-2" },
    include: { topic: { include: { chapter: { include: { subject: true } } } } },
  });

  return {
    organizationId: result.organizationId,
    userId: membership.userId,
    role: result.role,
    subjectId: outcome.topic.chapter.subjectId,
    gradeId: outcome.topic.chapter.subject.gradeId,
    chapterId: outcome.topic.chapterId,
    outcomeId: outcome.id,
  };
}

const actorOf = (ctx: Ctx) => ({
  organizationId: ctx.organizationId,
  userId: ctx.userId,
  role: ctx.role,
});

/** An approved question in the bank, ready to go into a paper. */
async function stockQuestion(
  ctx: Ctx,
  overrides: { difficulty?: "EASY" | "MEDIUM" | "HARD"; marks?: number } = {},
) {
  const created = await createQuestion(actorOf(ctx), {
    type: "MCQ",
    subjectId: ctx.subjectId,
    chapterId: ctx.chapterId,
    difficulty: overrides.difficulty ?? "MEDIUM",
    marks: overrides.marks ?? 1,
    stem: `A stocked question about similarity ${textToken()}`,
    options: [
      { key: "A", text: "AA", isCorrect: true },
      { key: "B", text: "SSS", isCorrect: false },
      { key: "C", text: "SAS", isCorrect: false },
    ],
    explanation: "Two equal angles force the third.",
    outcomeIds: [ctx.outcomeId],
  });
  if (!created.ok) throw new Error(`stock failed: ${JSON.stringify(created)}`);
  await approveQuestion(actorOf(ctx), created.id);
  return created.id;
}

async function newAssessment(ctx: Ctx, totalMarks = 3) {
  const result = await createAssessment(actorOf(ctx), {
    title: `Weekly test ${randomUUID().slice(0, 6)}`,
    subjectId: ctx.subjectId,
    gradeId: ctx.gradeId,
    durationMinutes: 45,
    totalMarks,
  });
  if ("error" in result) throw new Error(result.error);
  return result.id;
}

let A: Ctx;
let B: Ctx;

beforeAll(async () => {
  A = await makeOrg();
  B = await makeOrg();
});

describe("creating an assessment", () => {
  it("starts as a DRAFT with a default blueprint", async () => {
    const id = await newAssessment(A);
    const assessment = await getAssessment(A.organizationId, id);
    expect(assessment?.status).toBe("DRAFT");
    expect(assessment?.blueprint.difficultyMix).toEqual(
      DEFAULT_BLUEPRINT.difficultyMix,
    );
    expect(assessment?.questions).toEqual([]);
  });

  it("refuses a subject that is not taught in that class year", async () => {
    // Same mis-filing guard as classes and questions: a paper filed against
    // the wrong year measures the wrong syllabus and nothing looks wrong.
    const otherGrade = await prisma.grade.findFirstOrThrow({
      where: { id: { not: A.gradeId } },
    });
    const result = await createAssessment(actorOf(A), {
      title: "Mismatched",
      subjectId: A.subjectId,
      gradeId: otherGrade.id,
      durationMinutes: 45,
      totalMarks: 10,
    });
    expect(result).toHaveProperty("error");
  });

  it("refuses a class that does not study that subject", async () => {
    const otherSubject = await prisma.subject.findFirstOrThrow({
      where: { gradeId: A.gradeId, id: { not: A.subjectId } },
    });
    const klass = await createClass(actorOf(A), {
      name: "Class for another subject",
      gradeId: A.gradeId,
      subjectId: otherSubject.id,
      academicYear: "2026-27",
    });

    const result = await createAssessment(actorOf(A), {
      title: "Wrong class",
      subjectId: A.subjectId,
      gradeId: A.gradeId,
      classId: klass.id,
      durationMinutes: 45,
      totalMarks: 10,
    });
    expect(result).toHaveProperty("error");
  });
});

describe("the blueprint and the bank", () => {
  it("counts only APPROVED questions as available", async () => {
    // A draft is somebody's unfinished thought. Counting it would make the
    // feasibility check optimistic in exactly the way that wastes an evening.
    const ctx = await makeOrg();
    const unapproved = await createQuestion(actorOf(ctx), {
      type: "MCQ",
      subjectId: ctx.subjectId,
      chapterId: ctx.chapterId,
      difficulty: "EASY",
      marks: 1,
      stem: `A draft nobody approved ${textToken()}`,
      options: [
        { key: "A", text: "AA", isCorrect: true },
        { key: "B", text: "SSS", isCorrect: false },
      ],
      explanation: "x",
      outcomeIds: [ctx.outcomeId],
    });
    expect(unapproved.ok).toBe(true);

    const before = await bankInventory(ctx.organizationId, ctx.subjectId, [
      ctx.outcomeId,
    ]);
    expect(before).toEqual([]);

    await stockQuestion(ctx, { difficulty: "EASY" });
    const after = await bankInventory(ctx.organizationId, ctx.subjectId, [
      ctx.outcomeId,
    ]);
    expect(after).toEqual([{ difficulty: "EASY", type: "MCQ", count: 1 }]);
  });

  it("reports a shortfall rather than promising a paper it cannot fill", async () => {
    const ctx = await makeOrg();
    await stockQuestion(ctx, { difficulty: "MEDIUM" });

    const feasibility = await checkFeasibility(ctx.organizationId, ctx.subjectId, {
      totalQuestions: 10,
      totalMarks: 10,
      difficultyMix: { EASY: 0, MEDIUM: 100, HARD: 0 },
      typeMix: { MCQ: 100 },
      outcomeIds: [ctx.outcomeId],
    });

    expect(feasibility.feasible).toBe(false);
    expect(feasibility.wanted).toBe(10);
    expect(feasibility.supplied).toBe(1);
    expect(feasibility.shortfalls[0]).toMatchObject({ wanted: 10, available: 1 });
  });

  it("is feasible once the bank holds enough", async () => {
    const ctx = await makeOrg();
    for (let i = 0; i < 3; i++) await stockQuestion(ctx, { difficulty: "MEDIUM" });

    const feasibility = await checkFeasibility(ctx.organizationId, ctx.subjectId, {
      totalQuestions: 3,
      totalMarks: 3,
      difficultyMix: { EASY: 0, MEDIUM: 100, HARD: 0 },
      typeMix: { MCQ: 100 },
      outcomeIds: [ctx.outcomeId],
    });
    expect(feasibility.feasible).toBe(true);
  });
});

describe("assembling the paper", () => {
  it("sets questions in order and takes their marks", async () => {
    const id = await newAssessment(A);
    const ids = [await stockQuestion(A), await stockQuestion(A), await stockQuestion(A)];

    const result = await setQuestions(actorOf(A), id, ids);
    expect(result.ok).toBe(true);

    const assessment = await getAssessment(A.organizationId, id);
    expect(assessment?.questions.map((q) => q.position)).toEqual([1, 2, 3]);
    expect(assessment?.questions.map((q) => q.questionId)).toEqual(ids);
  });

  it("refuses a question from another subject", async () => {
    const id = await newAssessment(A);
    const otherSubject = await prisma.subject.findFirstOrThrow({
      where: { id: { not: A.subjectId } },
    });
    const stray = await createQuestion(actorOf(A), {
      type: "MCQ",
      subjectId: otherSubject.id,
      chapterId: null,
      difficulty: "EASY",
      marks: 1,
      stem: `A question from a different subject entirely ${textToken()}`,
      options: [
        { key: "A", text: "Yes", isCorrect: true },
        { key: "B", text: "No", isCorrect: false },
      ],
      explanation: "x",
    });
    if (!stray.ok) throw new Error("create failed");

    const result = await setQuestions(actorOf(A), id, [stray.id]);
    expect(result.ok).toBe(false);
  });

  it("deduplicates a question added twice", async () => {
    const id = await newAssessment(A);
    const question = await stockQuestion(A);
    await setQuestions(actorOf(A), id, [question, question]);
    const assessment = await getAssessment(A.organizationId, id);
    expect(assessment?.questions).toHaveLength(1);
  });
});

describe("the publish gate", () => {
  it("refuses an empty paper", async () => {
    const id = await newAssessment(A);
    const check = await publishCheck(A.organizationId, id);
    expect(check?.ready).toBe(false);
    expect(check?.problems[0]).toMatch(/no questions/);
  });

  it("refuses a paper whose marks do not add up", async () => {
    const id = await newAssessment(A, 10);
    await setQuestions(actorOf(A), id, [await stockQuestion(A)]);

    const check = await publishCheck(A.organizationId, id);
    expect(check?.ready).toBe(false);
    expect(check?.problems.some((p) => /add up to 1 marks/.test(p))).toBe(true);
  });

  it("refuses a paper containing an unapproved question", async () => {
    // A draft is somebody's unfinished thought.
    const id = await newAssessment(A, 1);
    const draft = await createQuestion(actorOf(A), {
      type: "MCQ",
      subjectId: A.subjectId,
      chapterId: A.chapterId,
      difficulty: "EASY",
      marks: 1,
      stem: `An unapproved question that must not reach a class ${textToken()}`,
      options: [
        { key: "A", text: "AA", isCorrect: true },
        { key: "B", text: "SSS", isCorrect: false },
      ],
      explanation: "x",
      outcomeIds: [A.outcomeId],
    });
    if (!draft.ok) throw new Error("create failed");

    await setQuestions(actorOf(A), id, [draft.id]);
    const result = await publishAssessment(actorOf(A), id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((p) => /not approved/.test(p))).toBe(true);
    }
  });

  it("publishes when everything holds, and freezes the versions", async () => {
    // The rule that makes an August paper keep marking the way it did in
    // August after the source question is edited in December.
    const id = await newAssessment(A, 2);
    const ids = [await stockQuestion(A), await stockQuestion(A)];
    await setQuestions(actorOf(A), id, ids);

    const result = await publishAssessment(actorOf(A), id);
    expect(result.ok).toBe(true);

    const assessment = await getAssessment(A.organizationId, id);
    expect(assessment?.status).toBe("PUBLISHED");
    expect(assessment?.publishedAt).toBeInstanceOf(Date);
    for (const question of assessment!.questions) {
      expect(question.frozenVersionId).toBeTruthy();
    }
  });

  it("a published paper cannot be edited", async () => {
    const id = await newAssessment(A, 1);
    await setQuestions(actorOf(A), id, [await stockQuestion(A)]);
    await publishAssessment(actorOf(A), id);

    const edit = await updateDraft(actorOf(A), id, { title: "Renamed" });
    expect(edit.ok).toBe(false);

    const requestions = await setQuestions(actorOf(A), id, [await stockQuestion(A)]);
    expect(requestions.ok).toBe(false);
  });

  it("closes a published paper", async () => {
    const id = await newAssessment(A, 1);
    await setQuestions(actorOf(A), id, [await stockQuestion(A)]);
    await publishAssessment(actorOf(A), id);

    expect(await closeAssessment(actorOf(A), id)).toBe(true);
    expect((await getAssessment(A.organizationId, id))?.status).toBe("CLOSED");
    // Closing twice is not an error worth raising, but it changes nothing.
    expect(await closeAssessment(actorOf(A), id)).toBe(false);
  });
});

describe("duplicating", () => {
  it("copies the questions but not the frozen versions", async () => {
    // A copy is a new draft and freezes afresh when it is published.
    const id = await newAssessment(A, 2);
    await setQuestions(actorOf(A), id, [
      await stockQuestion(A),
      await stockQuestion(A),
    ]);
    await publishAssessment(actorOf(A), id);

    const copy = await duplicateAssessment(actorOf(A), id);
    expect(copy).not.toBeNull();

    const duplicated = await getAssessment(A.organizationId, copy!.id);
    expect(duplicated?.status).toBe("DRAFT");
    expect(duplicated?.title).toMatch(/\(copy\)$/);
    expect(duplicated?.questions).toHaveLength(2);
    for (const question of duplicated!.questions) {
      expect(question.frozenVersionId).toBeNull();
    }
  });
});

describe("tenancy", () => {
  it("one organization does not see another's assessments", async () => {
    await newAssessment(B);
    const mine = await listAssessments(A.organizationId);
    const theirs = await listAssessments(B.organizationId);
    const overlap = mine.filter((m) => theirs.some((t) => t.id === m.id));
    expect(overlap).toEqual([]);
  });

  it("returns null for another organization's assessment by exact id", async () => {
    const id = await newAssessment(B);
    expect(await getAssessment(A.organizationId, id)).toBeNull();
    expect(await getAssessment(B.organizationId, id)).not.toBeNull();
  });

  it("cannot publish or close another organization's assessment", async () => {
    const id = await newAssessment(B, 1);
    await setQuestions(actorOf(B), id, [await stockQuestion(B)]);

    const published = await publishAssessment(actorOf(A), id);
    expect(published.ok).toBe(false);
    expect(await closeAssessment(actorOf(A), id)).toBe(false);

    expect((await getAssessment(B.organizationId, id))?.status).toBe("DRAFT");
  });
});

describe("the blueprint a new assessment starts with", () => {
  it("matches the marks the teacher actually typed", async () => {
    // Opening step 3 with "20 questions" under a paper set to 4 marks is the
    // builder contradicting itself before the teacher has done anything.
    const id = await newAssessment(A, 4);
    const assessment = await getAssessment(A.organizationId, id);
    expect(assessment?.blueprint.totalMarks).toBe(4);
    expect(assessment?.blueprint.totalQuestions).toBe(4);
  });

  it("keeps the default difficulty and type shape", async () => {
    const id = await newAssessment(A, 25);
    const assessment = await getAssessment(A.organizationId, id);
    expect(assessment?.blueprint.difficultyMix).toEqual({
      EASY: 30,
      MEDIUM: 50,
      HARD: 20,
    });
    expect(assessment?.blueprint.totalQuestions).toBe(25);
  });
});
