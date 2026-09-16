import { randomUUID } from "node:crypto";
import { signUp } from "@/core/identity/accounts";
import { createClass } from "@/core/classes";
import { addStudents } from "@/core/roster/add";
import { parseRoster } from "@/core/roster/parse";
import { approveQuestion, createQuestion } from "@/core/questions";
import { createAssessment, publishAssessment, setQuestions } from "@/core/assessments";
import { createAssignment } from "@/core/assignments";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { textToken } from "./text-token";

/**
 * A whole world, shared by every integration suite that needs one.
 *
 * Extracted from attempts.test.ts when the results suite needed the same
 * fixture: two copies of a setup this size drift within a week, and a fixture
 * that differs between suites is how a passing test stops meaning anything.
 */

export const hours = (n: number) => n * 3600_000;

export type World = {
  organizationId: string;
  teacherId: string;
  role: string;
  classId: string;
  studentId: string;
  otherStudentId: string;
  assignmentId: string;
  questionIds: string[];
  subjectId: string;
  chapterId: string;
  outcomeId: string;
};

export const teacherOf = (w: World) => ({
  organizationId: w.organizationId,
  userId: w.teacherId,
  role: w.role,
});
export const studentOf = (w: World) => ({
  organizationId: w.organizationId,
  userId: w.studentId,
});

/**
 * A whole world: org, class, two students, an approved two-question paper,
 * published and assigned with an open window.
 */
export async function makeWorld(
  options: { maxAttempts?: number; closesInMs?: number; withWritten?: boolean } = {},
) {
  const signup = await signUp({
    fullName: "Teacher",
    email: `att-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Attempt Org",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!signup.ok) throw new Error("signUp failed");

  const membership = await withTenant(signup.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );

  const outcome = await prisma.learningOutcome.findFirstOrThrow({
    where: { code: "SIM-2" },
    include: { topic: { include: { chapter: { include: { subject: true } } } } },
  });

  const world: World = {
    organizationId: signup.organizationId,
    teacherId: membership.userId,
    role: signup.role,
    classId: "",
    studentId: "",
    otherStudentId: "",
    assignmentId: "",
    questionIds: [],
    subjectId: outcome.topic.chapter.subjectId,
    chapterId: outcome.topic.chapterId,
    outcomeId: outcome.id,
  };

  const klass = await createClass(teacherOf(world), {
    name: "Class 10-A",
    gradeId: outcome.topic.chapter.subject.gradeId,
    subjectId: outcome.topic.chapter.subjectId,
    academicYear: "2026-27",
  });
  world.classId = klass.id;

  const roster = await addStudents(
    teacherOf(world),
    klass.id,
    parseRoster(`Arun ${randomUUID().slice(0, 6)}\nMeera ${randomUUID().slice(0, 6)}`)
      .students,
  );
  const added = roster.outcomes.flatMap((o) => (o.status === "added" ? [o.userId] : []));
  world.studentId = added[0]!;
  world.otherStudentId = added[1]!;

  // One MCQ and one true/false, so marking covers more than a single branch.
  const mcq = await createQuestion(teacherOf(world), {
    type: "MCQ",
    subjectId: outcome.topic.chapter.subjectId,
    chapterId: outcome.topic.chapterId,
    difficulty: "MEDIUM",
    marks: 2,
    stem: `Which criterion needs two pairs of equal angles? ${textToken()}`,
    options: [
      { key: "A", text: "AA", isCorrect: true },
      { key: "B", text: "SSS", isCorrect: false },
      { key: "C", text: "SAS", isCorrect: false },
    ],
    explanation: "Two equal angles force the third.",
    outcomeIds: [outcome.id],
  });
  if (!mcq.ok) throw new Error("mcq failed");
  await approveQuestion(teacherOf(world), mcq.id);

  const tf = await createQuestion(teacherOf(world), {
    type: "TRUE_FALSE",
    subjectId: outcome.topic.chapter.subjectId,
    chapterId: outcome.topic.chapterId,
    difficulty: "EASY",
    marks: 1,
    stem: `Similar triangles always have equal areas. ${textToken()}`,
    answerKey: { kind: "boolean", correct: false },
    explanation: "Areas scale with the square of the side ratio.",
    outcomeIds: [outcome.id],
  });
  if (!tf.ok) throw new Error("tf failed");
  await approveQuestion(teacherOf(world), tf.id);

  world.questionIds = [mcq.id, tf.id];

  // A written answer, when the test needs one. Nothing marks it automatically,
  // which is the whole point: it is the only way to reach the "waiting on a
  // person" state.
  if (options.withWritten) {
    const written = await createQuestion(teacherOf(world), {
      type: "SA",
      subjectId: outcome.topic.chapter.subjectId,
      chapterId: outcome.topic.chapterId,
      difficulty: "MEDIUM",
      marks: 3,
      stem: `Explain why AA is enough to prove similarity. ${textToken()}`,
      explanation: "The third angle follows, so the triangles are equiangular.",
      outcomeIds: [outcome.id],
    });
    if (!written.ok) throw new Error("written failed");
    await approveQuestion(teacherOf(world), written.id);
    world.questionIds.push(written.id);
  }

  const assessment = await createAssessment(teacherOf(world), {
    title: `Paper ${randomUUID().slice(0, 6)}`,
    subjectId: outcome.topic.chapter.subjectId,
    gradeId: outcome.topic.chapter.subject.gradeId,
    durationMinutes: 45,
    totalMarks: options.withWritten ? 6 : 3,
  });
  if ("error" in assessment) throw new Error(assessment.error);

  await setQuestions(teacherOf(world), assessment.id, world.questionIds);
  const published = await publishAssessment(teacherOf(world), assessment.id);
  if (!published.ok) throw new Error(JSON.stringify(published.problems));

  const assignment = await createAssignment(teacherOf(world), {
    assessmentId: assessment.id,
    classId: klass.id,
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + (options.closesInMs ?? hours(24))),
    maxAttempts: options.maxAttempts ?? 1,
    resultsPolicy: "IMMEDIATE",
  });
  if (!assignment.ok) throw new Error(assignment.message);
  world.assignmentId = assignment.id;

  return world;
}
