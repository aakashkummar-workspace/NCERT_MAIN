import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createAssignment } from "@/core/assignments";
import { startAttempt } from "@/core/attempts";
import { studentAssignments } from "@/core/attempts/student-view";
import { paperSheet, recordPaperSitting, sheetCodeFor, type PaperEntry } from "@/core/paper";
import { markingQueue } from "@/core/results/marking";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { hours, makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

/** The world's paper, assigned again to the same class — to be sat on paper. */
async function paperAssignment(world: World) {
  const online = await withTenant(world.organizationId, (tx) =>
    tx.assignment.findUniqueOrThrow({ where: { id: world.assignmentId } }),
  );
  const created = await createAssignment(teacherOf(world), {
    assessmentId: online.assessmentId,
    classId: world.classId,
    opensAt: new Date(Date.now() - hours(48)),
    closesAt: new Date(Date.now() - hours(46)),
    maxAttempts: 1,
    resultsPolicy: "IMMEDIATE",
    deliveryMode: "PAPER",
  });
  if (!created.ok) throw new Error(created.message);
  return created.id;
}

async function entriesFor(world: World, assignmentId: string) {
  const sheet = (await paperSheet(world.organizationId, assignmentId))!;
  const mcq = sheet.questions.find((q) => q.type === "MCQ")!;
  const tf = sheet.questions.find((q) => q.type === "TRUE_FALSE")!;
  const written = sheet.questions.find((q) => !q.objective);
  return { sheet, mcq, tf, written };
}

async function evidenceCount(world: World, attemptId: string) {
  return withTenant(world.organizationId, async (tx) => {
    const answers = await tx.attemptAnswer.findMany({ where: { attemptId }, select: { id: true } });
    return tx.conceptEvidence.findMany({
      where: { attemptAnswerId: { in: answers.map((a) => a.id) } },
    });
  });
}

describe("a paper sat on paper", () => {
  it("cannot be started in the player, and the student is told why", async () => {
    const world = await makeWorld();
    const assignmentId = await paperAssignment(world);
    const started = await startAttempt(studentOf(world), assignmentId, randomUUID());
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.message).toMatch(/on paper/);

    const listed = await studentAssignments(world.organizationId, world.studentId);
    const card = listed.find((a) => a.assignmentId === assignmentId)!;
    expect(card.onPaper).toBe(true);
    expect(card.canStart).toBe(false);
  });

  it("marks the letters recorded against the frozen key, dated to the day it was sat", async () => {
    const world = await makeWorld();
    const assignmentId = await paperAssignment(world);
    const { mcq, tf } = await entriesFor(world, assignmentId);
    const satOn = new Date(Date.now() - hours(47));

    const entries: PaperEntry[] = [
      { assessmentQuestionId: mcq.assessmentQuestionId, kind: "choice", keys: ["A"] },
      { assessmentQuestionId: tf.assessmentQuestionId, kind: "boolean", value: true },
    ];
    const result = await recordPaperSitting(teacherOf(world), assignmentId, world.studentId, entries, satOn);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The MCQ key is A (2 marks); the true/false key is False.
    expect(result.rawScore).toBe(2);
    expect(result.maxScore).toBe(3);

    const attempt = await withTenant(world.organizationId, (tx) =>
      tx.attempt.findUniqueOrThrow({ where: { id: result.attemptId } }),
    );
    expect(attempt.submitReason).toBe("PAPER");
    expect(attempt.submittedAt?.getTime()).toBe(satOn.getTime());

    const evidence = await evidenceCount(world, result.attemptId);
    expect(evidence.length).toBeGreaterThan(0);
    for (const row of evidence) expect(row.observedAt.getTime()).toBe(satOn.getTime());
  });

  it("corrects in place: one sitting, and the evidence rewritten rather than doubled", async () => {
    const world = await makeWorld();
    const assignmentId = await paperAssignment(world);
    const { mcq, tf } = await entriesFor(world, assignmentId);

    const first = await recordPaperSitting(teacherOf(world), assignmentId, world.studentId, [
      { assessmentQuestionId: mcq.assessmentQuestionId, kind: "choice", keys: ["A"] },
      { assessmentQuestionId: tf.assessmentQuestionId, kind: "boolean", value: false },
    ]);
    if (!first.ok) throw new Error(first.message);
    const before = await evidenceCount(world, first.attemptId);

    const second = await recordPaperSitting(teacherOf(world), assignmentId, world.studentId, [
      { assessmentQuestionId: mcq.assessmentQuestionId, kind: "choice", keys: ["B"] },
      { assessmentQuestionId: tf.assessmentQuestionId, kind: "blank" },
    ]);
    if (!second.ok) throw new Error(second.message);
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.created).toBe(false);
    expect(second.rawScore).toBe(0);

    const attempts = await withTenant(world.organizationId, (tx) =>
      tx.attempt.count({ where: { assignmentId, studentUserId: world.studentId } }),
    );
    expect(attempts).toBe(1);

    const after = await evidenceCount(world, first.attemptId);
    // The blank true/false carries no evidence any more; the MCQ's is now a 0.
    expect(after.length).toBeLessThan(before.length);
    expect(after.every((row) => Number(row.score) === 0)).toBe(true);
  });

  it("sends a written answer to the marking queue, pointing at the script", async () => {
    const world = await makeWorld({ withWritten: true });
    const assignmentId = await paperAssignment(world);
    const { mcq, written } = await entriesFor(world, assignmentId);

    const result = await recordPaperSitting(teacherOf(world), assignmentId, world.studentId, [
      { assessmentQuestionId: mcq.assessmentQuestionId, kind: "choice", keys: ["A"] },
      { assessmentQuestionId: written!.assessmentQuestionId, kind: "written", marks: null },
    ]);
    if (!result.ok) throw new Error(result.message);
    expect(result.pendingMarks).toBe(3);

    const queue = await markingQueue(teacherOf(world), assignmentId);
    const answers = queue?.groups.flatMap((group) => group.answers) ?? [];
    expect(answers.some((answer) => /paper script/.test(answer.response))).toBe(true);
  });

  it("takes a written mark directly, in halves, and refuses one out of range", async () => {
    const world = await makeWorld({ withWritten: true });
    const assignmentId = await paperAssignment(world);
    const { written } = await entriesFor(world, assignmentId);

    const ok = await recordPaperSitting(teacherOf(world), assignmentId, world.studentId, [
      { assessmentQuestionId: written!.assessmentQuestionId, kind: "written", marks: 2.5 },
    ]);
    expect(ok.ok && ok.rawScore).toBe(2.5);

    const tooMany = await recordPaperSitting(teacherOf(world), assignmentId, world.otherStudentId, [
      { assessmentQuestionId: written!.assessmentQuestionId, kind: "written", marks: 4 },
    ]);
    expect(tooMany.ok).toBe(false);
  });

  it("refuses an option the question does not have", async () => {
    const world = await makeWorld();
    const assignmentId = await paperAssignment(world);
    const { mcq } = await entriesFor(world, assignmentId);
    const result = await recordPaperSitting(teacherOf(world), assignmentId, world.studentId, [
      { assessmentQuestionId: mcq.assessmentQuestionId, kind: "choice", keys: ["Z"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/no option Z/);
  });

  it("will not type over a paper sat online", async () => {
    const world = await makeWorld();
    const { mcq } = await entriesFor(world, world.assignmentId);
    const result = await recordPaperSitting(teacherOf(world), world.assignmentId, world.studentId, [
      { assessmentQuestionId: mcq.assessmentQuestionId, kind: "choice", keys: ["A"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONFLICT");
  });

  it("gives each student a stable sheet code, distinct within the class", async () => {
    const world = await makeWorld();
    const assignmentId = await paperAssignment(world);
    const sheet = (await paperSheet(world.organizationId, assignmentId))!;
    const codes = sheet.students.map((s) => s.sheetCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(sheetCodeFor(assignmentId, world.studentId)).toBe(
      sheet.students.find((s) => s.userId === world.studentId)!.sheetCode,
    );
    // The sheet never carries which option is right.
    expect(JSON.stringify(sheet)).not.toMatch(/isCorrect|answerKey/);
  });
});
