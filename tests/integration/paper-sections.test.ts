import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createAssessment,
  getAssessment,
  publishAssessment,
  publishCheck,
  setQuestions,
  updateDraft,
} from "@/core/assessments";
import { paperForPrint } from "@/core/assessments/paper";
import { CBSE_PATTERNS, patternQuestionCount } from "@/core/assessments/pattern";
import { createAssignment } from "@/core/assignments";
import { getPlayer, saveAnswers, startAttempt, submitAttempt } from "@/core/attempts";
import { approveQuestion, createQuestion } from "@/core/questions";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { textToken } from "./support/text-token";
import { hours, makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

async function mcq(world: World, marks: number, correct: "A" | "B") {
  const created = await createQuestion(teacherOf(world), {
    type: "MCQ",
    subjectId: world.subjectId,
    chapterId: world.chapterId,
    difficulty: "MEDIUM",
    marks,
    stem: `Which is right? ${textToken()}`,
    options: [
      { key: "A", text: `First ${textToken()}`, isCorrect: correct === "A" },
      { key: "B", text: `Second ${textToken()}`, isCorrect: correct === "B" },
    ],
    explanation: "Because.",
    outcomeIds: [world.outcomeId],
  });
  if (!created.ok) throw new Error("question failed");
  await approveQuestion(teacherOf(world), created.id);
  return created.id;
}

/** A published paper: one ordinary question, then an OR pair of 2-markers. */
async function paperWithChoice(world: World) {
  const plain = await mcq(world, 1, "A");
  const first = await mcq(world, 2, "A");
  const second = await mcq(world, 2, "B");
  const assessment = await createAssessment(teacherOf(world), {
    title: `Choice ${randomUUID().slice(0, 6)}`,
    subjectId: world.subjectId,
    gradeId: (await getAssessmentGrade(world))!,
    durationMinutes: 30,
    totalMarks: 3,
  });
  if ("error" in assessment) throw new Error(assessment.error);
  const saved = await setQuestions(teacherOf(world), assessment.id, [
    { questionId: plain },
    { questionId: first, choiceGroup: 1 },
    { questionId: second, choiceGroup: 1 },
  ]);
  expect(saved.ok).toBe(true);
  return { assessmentId: assessment.id, plain, first, second };
}

async function getAssessmentGrade(world: World) {
  const subject = await prisma.subject.findUnique({ where: { id: world.subjectId } });
  return subject?.gradeId;
}

async function sit(world: World, assessmentId: string) {
  const published = await publishAssessment(teacherOf(world), assessmentId);
  if (!published.ok) throw new Error(JSON.stringify(published.problems));
  const assignment = await createAssignment(teacherOf(world), {
    assessmentId,
    classId: world.classId,
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + hours(2)),
    maxAttempts: 1,
    resultsPolicy: "IMMEDIATE",
  });
  if (!assignment.ok) throw new Error(assignment.message);
  const started = await startAttempt(studentOf(world), assignment.id, randomUUID());
  if (!started.ok) throw new Error(started.message);
  return started.attemptId;
}

describe("internal choice", () => {
  it("counts an OR pair once towards the paper's marks", async () => {
    const world = await makeWorld();
    const { assessmentId } = await paperWithChoice(world);
    const check = await publishCheck(world.organizationId, assessmentId);
    // 1 + 2, not 1 + 2 + 2.
    expect(check?.marksTotal).toBe(3);
    expect(check?.ready).toBe(true);
  });

  it("refuses an OR between questions of different marks", async () => {
    const world = await makeWorld();
    const one = await mcq(world, 1, "A");
    const two = await mcq(world, 2, "A");
    const assessment = await createAssessment(teacherOf(world), {
      title: `Bad choice ${randomUUID().slice(0, 6)}`,
      subjectId: world.subjectId,
      gradeId: (await getAssessmentGrade(world))!,
      durationMinutes: 30,
      totalMarks: 2,
    });
    if ("error" in assessment) throw new Error(assessment.error);
    const saved = await setQuestions(teacherOf(world), assessment.id, [
      { questionId: one, choiceGroup: 1 },
      { questionId: two, choiceGroup: 1 },
    ]);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error).toMatch(/same marks/);
  });

  it("numbers the pair once in the player and on the printout", async () => {
    const world = await makeWorld();
    const { assessmentId } = await paperWithChoice(world);
    const attemptId = await sit(world, assessmentId);
    const player = await getPlayer(studentOf(world), attemptId);
    expect(player?.questions.map((q) => q.number)).toEqual([1, 2, 2]);
    expect(player?.questions[1]!.choiceGroup).toBe(player?.questions[2]!.choiceGroup);

    const printed = await paperForPrint(world.organizationId, assessmentId);
    expect(printed.ok).toBe(true);
    if (!printed.ok) return;
    expect(printed.paper.questions.map((q) => q.number)).toEqual([1, 2, 2]);
    expect(printed.paper.questionMarks).toBe(3);
  });

  it("marks only the alternative the student took, and drops the other", async () => {
    const world = await makeWorld();
    const { assessmentId } = await paperWithChoice(world);
    const attemptId = await sit(world, assessmentId);
    const player = (await getPlayer(studentOf(world), attemptId))!;
    const [plain, , second] = player.questions;

    await saveAnswers(studentOf(world), attemptId, [
      { assessmentQuestionId: plain!.assessmentQuestionId, response: { kind: "choice", keys: ["A"] }, clientSeq: 1 },
      // The second alternative, answered correctly (its key is B).
      { assessmentQuestionId: second!.assessmentQuestionId, response: { kind: "choice", keys: ["B"] }, clientSeq: 2 },
    ]);
    const result = await submitAttempt(studentOf(world), attemptId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Full marks out of 3: the untaken first alternative is neither a blank
    // nor a mark.
    expect(result.rawScore).toBe(3);
    expect(result.maxScore).toBe(3);
    expect(result.provisional).toBe(false);

    const rows = await withTenant(world.organizationId, (tx) =>
      tx.attemptAnswer.findMany({ where: { attemptId } }),
    );
    expect(rows).toHaveLength(2);
  });

  it("keeps the first in paper order when both alternatives were answered", async () => {
    const world = await makeWorld();
    const { assessmentId } = await paperWithChoice(world);
    const attemptId = await sit(world, assessmentId);
    const player = (await getPlayer(studentOf(world), attemptId))!;
    const [, first, second] = player.questions;

    await saveAnswers(studentOf(world), attemptId, [
      // Wrong on the first (key A), right on the second (key B).
      { assessmentQuestionId: first!.assessmentQuestionId, response: { kind: "choice", keys: ["B"] }, clientSeq: 1 },
      { assessmentQuestionId: second!.assessmentQuestionId, response: { kind: "choice", keys: ["B"] }, clientSeq: 2 },
    ]);
    const result = await submitAttempt(studentOf(world), attemptId);
    if (!result.ok) throw new Error("submit failed");
    // The first attempted is retained — answering both is not a second go.
    expect(result.rawScore).toBe(0);
    expect(result.maxScore).toBe(3);
  });
});

describe("the board pattern", () => {
  it("places questions in their sections and orders the paper by section", async () => {
    const world = await makeWorld();
    const pattern = CBSE_PATTERNS.MATH;
    const assessment = await createAssessment(teacherOf(world), {
      title: `Pre-board ${randomUUID().slice(0, 6)}`,
      subjectId: world.subjectId,
      gradeId: (await getAssessmentGrade(world))!,
      durationMinutes: 180,
      totalMarks: 80,
    });
    if ("error" in assessment) throw new Error(assessment.error);
    const updated = await updateDraft(teacherOf(world), assessment.id, {
      blueprint: {
        totalQuestions: patternQuestionCount(pattern.sections),
        totalMarks: 80,
        difficultyMix: { EASY: 30, MEDIUM: 50, HARD: 20 },
        typeMix: {},
        outcomeIds: [],
        pattern: { key: pattern.key, label: pattern.label, sections: pattern.sections },
      },
    });
    expect(updated.ok).toBe(true);

    const written = await createQuestion(teacherOf(world), {
      type: "SA",
      subjectId: world.subjectId,
      chapterId: world.chapterId,
      difficulty: "MEDIUM",
      marks: 3,
      stem: `Prove it. ${textToken()}`,
      explanation: "By AA.",
      outcomeIds: [world.outcomeId],
    });
    if (!written.ok) throw new Error("written failed");
    await approveQuestion(teacherOf(world), written.id);
    const objective = await mcq(world, 1, "A");

    // Ticked in the "wrong" order: the SA first.
    await setQuestions(teacherOf(world), assessment.id, [written.id, objective]);
    const read = await getAssessment(world.organizationId, assessment.id);
    expect(read?.questions.map((q) => q.section)).toEqual(["A", "C"]);
    expect(read?.questions.map((q) => q.questionId)).toEqual([objective, written.id]);
  });
});
