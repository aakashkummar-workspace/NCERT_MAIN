import { randomUUID } from "node:crypto";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
} from "@/core/attempts";
import { approveQuestion, createQuestion } from "@/core/questions";
import { createAssessment, publishAssessment, setQuestions } from "@/core/assessments";
import { createAssignment } from "@/core/assignments";
import { prisma } from "@/db/client";
import { platformPrisma } from "@/db/platform";
import { withTenant } from "@/db/tenant";
import { fixtureChapter } from "./fixture-curriculum";
import { makeWorld, studentOf, teacherOf, type World } from "./world";
import { textToken } from "./text-token";

/**
 * A world whose student is measured on three concepts.
 *
 * Extracted from reports.test.ts when the exam-series suite needed the same
 * thing: a report refuses below three measured concepts, so any suite that
 * wants a REPORT rather than a refusal has to build one of these. Two copies
 * of a fixture this size drift inside a week — the same reason `makeWorld`
 * lives here rather than in the suite that first needed it.
 */

export async function grantReports(organizationId: string) {
  const plan = await prisma.plan.findFirstOrThrow({ where: { code: "teacher_pro" } });
  await withTenant(organizationId, async (tx) => {
    const existing = await tx.subscription.findFirst({ where: { planId: plan.id } });
    if (existing) return;
    await tx.subscription.createMany({
      data: [{ id: randomUUID(), organizationId, planId: plan.id, status: "ACTIVE" }],
    });
  });
}


/**
 * A student measured on THREE concepts, which the seed cannot supply.
 *
 * The seeded curriculum holds two concepts in total — a designed state, not a
 * bug: concepts are authored by somebody who teaches the subject, and inventing
 * four hundred of them would be exactly the guess this product refuses. But a
 * report needs three measured before it will exist, so this test authors its
 * own on the platform connection, the way `sahayak_platform` is the only role
 * that can.
 *
 * Worth stating plainly, because it is a real finding rather than test
 * scaffolding: **no real organisation can be handed a report today**, because
 * no real organisation has three concepts to be measured on. The refusal is
 * correct and the curriculum is what is missing.
 */
export async function measuredWorld(): Promise<{ world: World; assignmentId: string }> {
  const world = await makeWorld({ maxAttempts: 5 });
  await grantReports(world.organizationId);

  // A fixture chapter in the world's subject, so the questions below still fit
  // its class and paper. This used to add three outcomes to the seeded
  // similarity chapter on every run, and a concept for each.
  const fixture = await fixtureChapter({ subjectId: world.subjectId, label: "Reporting" });
  const topicId = fixture.topicId;

  // Three outcomes, each covered by its own concept. Written on the platform
  // connection: the app role has no insert grant on the curriculum plane at
  // all, and a test that could write curriculum as the app would be proving
  // the opposite of what the two-role split exists for.
  const outcomeIds: string[] = [];
  for (const index of [1, 2, 3]) {
    const suffix = randomUUID().slice(0, 6);
    const outcome = await platformPrisma.learningOutcome.create({
      data: {
        topicId,
        code: `RPT-${index}-${suffix}`,
        statement: `Apply the ${index}th reporting idea to a worked problem.`,
        bloomLevel: "APPLY",
        sortOrder: index,
      },
    });
    const concept = await platformPrisma.concept.create({
      data: {
        name: `Reporting concept ${index} ${suffix}`,
        slug: `reporting-concept-${index}-${suffix}`,
      },
    });
    await platformPrisma.conceptOutcome.create({
      data: { conceptId: concept.id, learningOutcomeId: outcome.id, weight: 1 },
    });
    outcomeIds.push(outcome.id);
  }

  // One question per concept. Four sittings then produce exactly MIN_EVIDENCE
  // answers on each — the smallest world that can carry a report, which keeps
  // this suite's setup honest as well as quick.
  const questionIds: string[] = [];
  for (const [index, outcomeId] of outcomeIds.entries()) {
    const created = await createQuestion(teacherOf(world), {
      type: "MCQ",
      subjectId: world.subjectId,
      chapterId: fixture.chapterId,
      difficulty: "MEDIUM",
      marks: 1,
      stem: `Reporting question ${index} ${textToken()} — which applies?`,
      options: [
        { key: "A", text: "The right one", isCorrect: true },
        { key: "B", text: "A wrong one", isCorrect: false },
        { key: "C", text: "Another wrong one", isCorrect: false },
      ],
      explanation: "Because the definition says so.",
      outcomeIds: [outcomeId],
    });
    if (!created.ok) throw new Error(`createQuestion: ${created.code}`);
    await approveQuestion(teacherOf(world), created.id);
    questionIds.push(created.id);
  }

  const subject = await platformPrisma.subject.findFirstOrThrow({
    where: { id: world.subjectId },
    select: { gradeId: true },
  });
  const assessment = await createAssessment(teacherOf(world), {
    title: `Reporting paper ${randomUUID().slice(0, 6)}`,
    subjectId: world.subjectId,
    gradeId: subject.gradeId,
    durationMinutes: 30,
    totalMarks: questionIds.length,
  });
  if ("error" in assessment) throw new Error(assessment.error);
  await setQuestions(teacherOf(world), assessment.id, questionIds);
  await publishAssessment(teacherOf(world), assessment.id);

  const assigned = await createAssignment(teacherOf(world), {
    assessmentId: assessment.id,
    classId: world.classId,
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 86_400_000),
    maxAttempts: 5,
    resultsPolicy: "IMMEDIATE",
  });
  if (!assigned.ok) throw new Error("createAssignment failed");

  for (let pass = 0; pass < 4; pass++) {
    await sitAssignment(world, assigned.id);
  }
  // The assignment id travels back: a caller that wants to group this paper
  // into an exam series cannot go looking for it afterwards without guessing
  // which of the world's papers it is.
  return { world, assignmentId: assigned.id };
}

/** Sit a named assignment badly, so every concept is measured and below par. */
export async function sitAssignment(world: World, assignmentId: string) {
  const actor = studentOf(world);
  const started = await startAttempt(actor, assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);
  const player = await getPlayer(actor, started.attemptId);
  await saveAnswers(
    actor,
    started.attemptId,
    player!.questions.map((question, index) => ({
      assessmentQuestionId: question.assessmentQuestionId,
      response: { kind: "choice" as const, keys: ["B"] },
      clientSeq: index + 1,
    })),
  );
  await submitAttempt(actor, started.attemptId);
}
