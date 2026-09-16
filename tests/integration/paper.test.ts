import { afterAll, describe, expect, it } from "vitest";
import { answerKeyForPrint, paperForPrint } from "@/core/assessments/paper";
import { createAssessment, setQuestions } from "@/core/assessments";
import { getQuestion, updateQuestion } from "@/core/questions";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Printing a paper.
 *
 * The claims worth a database: it prints what was PUBLISHED rather than what
 * the question says today, the paper carries no answer, the key derives the
 * answer the way the marking does, and a draft is refused.
 */

async function assessmentOf(world: World): Promise<string> {
  const assignment = await withTenant(world.organizationId, (tx) =>
    tx.assignment.findFirstOrThrow({
      where: { id: world.assignmentId },
      select: { assessmentId: true },
    }),
  );
  return assignment.assessmentId;
}

describe("a paper prints what was published", () => {
  it("keeps the frozen wording after the question is edited", async () => {
    const world = await makeWorld();
    const id = await assessmentOf(world);

    const before = await paperForPrint(world.organizationId, id);
    if (!before.ok) throw new Error(before.message);
    const printedStem = before.paper.questions[0]!.stem;

    // Editing an approved question creates version n+1 and drops it to DRAFT.
    // The paper was published against version n, and must not follow.
    //
    // updateQuestion carries forward only the rubric, the hint and the
    // expected time, so the rest of the question is sent as it stands.
    const current = await getQuestion(world.organizationId, world.questionIds[0]!);
    if (!current) throw new Error("question not found");
    const edited = await updateQuestion(teacherOf(world), world.questionIds[0]!, {
      type: current.type,
      subjectId: current.subjectId,
      chapterId: current.chapterId,
      difficulty: current.difficulty as "EASY" | "MEDIUM" | "HARD",
      marks: current.marks,
      stem: "REWORDED AFTER PUBLISH — which of these applies to the figure?",
      options: current.options,
      explanation: current.explanation,
      outcomeIds: current.outcomeIds,
    });
    if (!edited.ok) throw new Error(JSON.stringify(edited));

    const after = await paperForPrint(world.organizationId, id);
    if (!after.ok) throw new Error(after.message);
    expect(after.paper.questions[0]!.stem).toBe(printedStem);
    expect(after.paper.questions[0]!.stem).not.toMatch(/REWORDED/);
  });

  it("orders the questions the way the paper does", async () => {
    const world = await makeWorld();
    const result = await paperForPrint(world.organizationId, await assessmentOf(world));
    if (!result.ok) throw new Error(result.message);
    const positions = result.paper.questions.map((question) => question.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("the paper carries no answer", () => {
  it("serialises with no key, no rubric and no isCorrect anywhere", async () => {
    const world = await makeWorld();
    const result = await paperForPrint(world.organizationId, await assessmentOf(world));
    if (!result.ok) throw new Error(result.message);

    // The whole payload, not the fields a reader remembered to check — the
    // same shape of test that guards getPlayer.
    const serialised = JSON.stringify(result.paper);
    expect(serialised).not.toContain("isCorrect");
    expect(serialised).not.toContain("answerKey");
    expect(serialised).not.toContain("rubric");
    expect(serialised).not.toContain("explanation");

    // And the options are still there to be printed.
    const choice = result.paper.questions.find((question) => question.options);
    expect(choice?.options?.length).toBeGreaterThan(1);
    expect(choice?.options?.[0]).toHaveProperty("text");
  });
});

describe("the key answers the way the marking does", () => {
  it("derives a choice answer from the options, not from answerKey", async () => {
    const world = await makeWorld();
    const key = await answerKeyForPrint(world.organizationId, await assessmentOf(world));
    if (!key.ok) throw new Error(key.message);

    const mcq = key.questions.find((question) => question.type === "MCQ");
    // A choice question's truth is options[].isCorrect and its answerKey
    // column is usually null; reading the column alone printed "marked by
    // hand" against every MCQ in the bank.
    expect(mcq?.answerLabel).toBeTruthy();

    const stored = await withTenant(world.organizationId, (tx) =>
      tx.questionVersion.findFirstOrThrow({
        where: { questionId: world.questionIds[0]! },
        orderBy: { version: "asc" },
        select: { options: true },
      }),
    );
    const correct = ((stored.options ?? []) as { key: string; isCorrect: boolean }[])
      .filter((option) => option.isCorrect)
      .map((option) => option.key)
      .join(", ");
    expect(mcq?.answerLabel).toBe(correct);
  });
});

describe("a draft cannot be printed", () => {
  it("refuses, and says why, rather than printing the live wording", async () => {
    const world = await makeWorld();
    const draft = await createAssessment(teacherOf(world), {
      title: `Draft paper ${Date.now()}`,
      subjectId: world.subjectId,
      gradeId: (
        await withTenant(world.organizationId, (tx) =>
          tx.subject.findFirstOrThrow({
            where: { id: world.subjectId },
            select: { gradeId: true },
          }),
        )
      ).gradeId,
      durationMinutes: 30,
      totalMarks: 3,
    });
    if ("error" in draft) throw new Error(draft.error);
    await setQuestions(teacherOf(world), draft.id, world.questionIds);

    const result = await paperForPrint(world.organizationId, draft.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-published");
    expect(result.message).toMatch(/published/i);

    const key = await answerKeyForPrint(world.organizationId, draft.id);
    expect(key.ok).toBe(false);
  });
});

describe("tenancy", () => {
  it("shows one organization nothing of another's paper", async () => {
    const world = await makeWorld();
    const id = await assessmentOf(world);
    const other = await makeWorld();

    const result = await paperForPrint(other.organizationId, id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });
});
