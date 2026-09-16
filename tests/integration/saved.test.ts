import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { releaseResults } from "@/core/results";
import {
  listSavedQuestions,
  saveQuestion,
  savedQuestionIds,
  savedSummary,
  unsaveQuestion,
} from "@/core/saved";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

const asStudent = (world: World, userId = world.studentId) => ({
  organizationId: world.organizationId,
  userId,
  role: "STUDENT",
});

/** Sit the world's paper, every answer right or every answer wrong. */
async function sit(world: World, correct: boolean, userId = world.studentId) {
  const actor = { organizationId: world.organizationId, userId };
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
      // The world's true/false is keyed `false`.
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "boolean", value: !correct },
        clientSeq: index + 1,
      });
    }
  }
  await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);
  return started.attemptId;
}

describe("what a student may save", () => {
  it("refuses a question they have never seen, as not found", async () => {
    const world = await makeWorld();
    // In the bank and on a paper, but this student has sat nothing.
    const result = await saveQuestion(asStudent(world), world.questionIds[0]!);
    expect(result).toEqual({ ok: false, reason: "not-found" });

    const invented = await saveQuestion(asStudent(world), randomUUID());
    expect(invented).toEqual({ ok: false, reason: "not-found" });
    const malformed = await saveQuestion(asStudent(world), "nope");
    expect(malformed).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses a paper they sat until its review is open", async () => {
    const world = await makeWorld();
    const attemptId = await sit(world, true);

    // Submitted, all right — so no mistake bank row — and the window is still
    // open, so the answers are not reviewable yet.
    expect((await saveQuestion(asStudent(world), world.questionIds[0]!)).ok).toBe(false);

    const released = await releaseResults(teacherOf(world), world.assignmentId);
    expect(released.ok).toBe(true);

    expect(await saveQuestion(asStudent(world), world.questionIds[0]!)).toEqual({ ok: true });
    const list = await listSavedQuestions(world.organizationId, world.studentId);
    expect(list.rows[0]?.review).toEqual({ kind: "result", href: `/student/results/${attemptId}/` });
  });

  it("admits a question from their mistake bank straight away", async () => {
    const world = await makeWorld();
    await sit(world, false);
    expect(await saveQuestion(asStudent(world), world.questionIds[0]!)).toEqual({ ok: true });
    const list = await listSavedQuestions(world.organizationId, world.studentId);
    expect(list.rows[0]?.review?.kind).toBe("mistake");
  });

  it("admits a question served in their own practice, and not a classmate's", async () => {
    const world = await makeWorld();
    const sessionId = randomUUID();
    // Arranged directly: what is under test is the save rule, not how
    // practice picks questions, which practice.test.ts already covers.
    await withTenant(world.organizationId, async (tx) => {
      await tx.practiceSession.create({
        data: {
          id: sessionId,
          organizationId: world.organizationId,
          studentUserId: world.studentId,
          source: "SELF_SELECTED",
          conceptIds: [],
          questionCount: 1,
        },
      });
      await tx.practiceAnswer.create({
        data: {
          id: randomUUID(),
          organizationId: world.organizationId,
          practiceSessionId: sessionId,
          questionId: world.questionIds[1]!,
          position: 1,
        },
      });
    });

    expect((await saveQuestion(asStudent(world), world.questionIds[1]!)).ok).toBe(true);
    const list = await listSavedQuestions(world.organizationId, world.studentId);
    expect(list.rows[0]?.review).toEqual({
      kind: "practice",
      href: `/student/practice/${sessionId}/`,
    });
    expect(
      (await saveQuestion(asStudent(world, world.otherStudentId), world.questionIds[1]!)).ok,
    ).toBe(false);
  });

  it("refuses anybody who is not a student", async () => {
    const world = await makeWorld();
    await sit(world, false);
    const teacher = { ...teacherOf(world) };
    expect((await saveQuestion(teacher, world.questionIds[0]!)).ok).toBe(false);
  });
});

describe("saving and unsaving", () => {
  it("is idempotent, keeps the first date, and unsaves", async () => {
    const world = await makeWorld();
    await sit(world, false);
    const questionId = world.questionIds[0]!;

    expect((await saveQuestion(asStudent(world), questionId)).ok).toBe(true);
    const first = await listSavedQuestions(world.organizationId, world.studentId);
    expect((await saveQuestion(asStudent(world), questionId)).ok).toBe(true);
    const second = await listSavedQuestions(world.organizationId, world.studentId);

    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.savedAt.getTime()).toBe(first.rows[0]!.savedAt.getTime());
    expect((await savedSummary(world.organizationId, world.studentId)).total).toBe(1);
    expect(
      (await savedQuestionIds(world.organizationId, world.studentId, [questionId])).has(questionId),
    ).toBe(true);

    expect((await unsaveQuestion(asStudent(world), questionId)).ok).toBe(true);
    expect((await listSavedQuestions(world.organizationId, world.studentId)).rows).toHaveLength(0);
    // Unsaving what is not saved leaves the list as asked for.
    expect((await unsaveQuestion(asStudent(world), questionId)).ok).toBe(true);
  });

  it("lists newest first with the stem, subject and chapter", async () => {
    const world = await makeWorld();
    await sit(world, false);
    await saveQuestion(asStudent(world), world.questionIds[0]!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await saveQuestion(asStudent(world), world.questionIds[1]!);

    const list = await listSavedQuestions(world.organizationId, world.studentId);
    expect(list.rows.map((row) => row.questionId)).toEqual([
      world.questionIds[1],
      world.questionIds[0],
    ]);
    expect(list.truncated).toBe(false);
    const mcq = list.rows[1]!;
    expect(mcq.stem).toMatch(/two pairs of equal angles/);
    expect(mcq.subjectName.length).toBeGreaterThan(0);
    expect(mcq.chapterTitle).not.toBeNull();
    expect(mcq.options?.map((option) => option.text)).toEqual(["AA", "SSS", "SAS"]);
  });

  it("never carries an answer key, a correct flag or an explanation", async () => {
    const world = await makeWorld();
    await sit(world, false);
    await saveQuestion(asStudent(world), world.questionIds[0]!);
    await saveQuestion(asStudent(world), world.questionIds[1]!);

    const serialised = JSON.stringify(
      await listSavedQuestions(world.organizationId, world.studentId),
    );
    expect(serialised).not.toMatch(/isCorrect|answerKey|explanation|correct/i);
    // The world's explanation text, not merely its field name.
    expect(serialised).not.toContain("Two equal angles force the third");
    expect(serialised).not.toContain("Areas scale with the square");
  });

  it("is one student's own list", async () => {
    const world = await makeWorld();
    await sit(world, false);
    await saveQuestion(asStudent(world), world.questionIds[0]!);

    // The classmate has sat nothing, so has seen nothing — even though the same
    // question is saved by somebody else.
    const classmate = asStudent(world, world.otherStudentId);
    expect((await saveQuestion(classmate, world.questionIds[0]!)).ok).toBe(false);
    expect((await listSavedQuestions(world.organizationId, world.otherStudentId)).rows).toHaveLength(0);

    // And their unsave cannot touch the other student's bookmark.
    await unsaveQuestion(classmate, world.questionIds[0]!);
    expect((await listSavedQuestions(world.organizationId, world.studentId)).rows).toHaveLength(1);

    // Another organization sees nothing of it.
    const elsewhere = await makeWorld();
    expect((await listSavedQuestions(elsewhere.organizationId, world.studentId)).rows).toHaveLength(0);
  });
});
