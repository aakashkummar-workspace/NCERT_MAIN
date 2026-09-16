import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { awardMarks, markingQueue } from "@/core/results/marking";
import { conceptCoverage, studentMastery } from "@/core/mastery/read";
import { rebuildMastery } from "@/core/mastery/sync";
import { MIN_EVIDENCE } from "@/core/mastery/estimate";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";
import { fixtureChapter, fixtureOutcome } from "./support/fixture-curriculum";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The seeded worked example maps two concepts across five outcomes on Class 10
 * Maths chapter 6. `makeWorld` builds its questions against outcome SIM-2, so
 * every question it creates is evidence about the concept that covers it.
 */
async function conceptOf(outcomeId: string): Promise<string | null> {
  const link = await prisma.conceptOutcome.findFirst({
    where: { learningOutcomeId: outcomeId },
  });
  return link?.conceptId ?? null;
}

/** Sits the paper answering every objective question the same way, and submits. */
async function sit(
  world: World,
  actor: { organizationId: string; userId: string },
  correct: boolean,
) {
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);

  const player = await getPlayer(actor, started.attemptId);
  const patches: AnswerPatch[] = [];
  for (const [index, question] of player!.questions.entries()) {
    if (question.type === "MCQ") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        // "A" is the key on the world's MCQ; "B" is a distractor.
        response: { kind: "choice", keys: [correct ? "A" : "B"] },
        clientSeq: index + 1,
      });
    } else if (question.type === "TRUE_FALSE") {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "boolean", value: !correct },
        clientSeq: index + 1,
      });
    }
  }
  if (patches.length > 0) await saveAnswers(actor, started.attemptId, patches);

  await submitAttempt(actor, started.attemptId);
  return started.attemptId;
}

const evidenceRows = (world: World) =>
  withTenant(world.organizationId, (tx) =>
    tx.conceptEvidence.findMany({ where: { studentUserId: world.studentId } }),
  );

describe("the evidence ledger", () => {
  it("writes one row per marked answer, per concept it maps to", async () => {
    const world = await makeWorld();
    await sit(world, studentOf(world), true);

    const rows = await evidenceRows(world);
    const conceptId = await conceptOf(world.outcomeId);
    expect(conceptId).not.toBeNull();

    // Two objective questions, one concept behind the outcome they share.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.conceptId))).toEqual(new Set([conceptId]));
    expect(rows.every((row) => Number(row.score) === 1)).toBe(true);
  });

  it("dates evidence to the day the paper was sat", async () => {
    const world = await makeWorld();
    const attemptId = await sit(world, studentOf(world), true);

    const attempt = await withTenant(world.organizationId, (tx) =>
      tx.attempt.findUniqueOrThrow({ where: { id: attemptId } }),
    );
    const rows = await evidenceRows(world);

    // Not the day it was marked. A December marking session is not December
    // evidence, and the recency decay has to measure from the sitting.
    for (const row of rows) {
      expect(row.observedAt.getTime()).toBe(attempt.submittedAt!.getTime());
    }
  });

  it("records partial credit as a fraction, not as right or wrong", async () => {
    const world = await makeWorld({ withWritten: true });
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const written = player!.questions.find((q) => q.type === "SA")!;
    await saveAnswers(studentOf(world), started.attemptId, [
      {
        assessmentQuestionId: written.assessmentQuestionId,
        response: { kind: "text", value: "Half an answer." },
        clientSeq: 1,
      },
    ]);
    await submitAttempt(studentOf(world), started.attemptId);

    // Nothing yet: a written answer is not evidence until a person reads it.
    const before = await evidenceRows(world);
    expect(before).toHaveLength(0);

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    await awardMarks(teacherOf(world), queue!.groups[0]!.answers[0]!.answerId, 2);

    const after = await evidenceRows(world);
    expect(after).toHaveLength(1);
    // Two marks out of three. Rounded either way it would be a lie the
    // estimator can never recover from.
    expect(Number(after[0]!.score)).toBeCloseTo(2 / 3, 3);
  });

  it("updates rather than duplicates when a mark is changed", async () => {
    const world = await makeWorld({ withWritten: true });
    const started = await startAttempt(studentOf(world), world.assignmentId, randomUUID());
    if (!started.ok) throw new Error("start failed");

    const player = await getPlayer(studentOf(world), started.attemptId);
    const written = player!.questions.find((q) => q.type === "SA")!;
    await saveAnswers(studentOf(world), started.attemptId, [
      {
        assessmentQuestionId: written.assessmentQuestionId,
        response: { kind: "text", value: "An answer." },
        clientSeq: 1,
      },
    ]);
    await submitAttempt(studentOf(world), started.attemptId);

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const answerId = queue!.groups[0]!.answers[0]!.answerId;

    await awardMarks(teacherOf(world), answerId, 1);
    await awardMarks(teacherOf(world), answerId, 3);

    const rows = await evidenceRows(world);
    // One row, carrying the second verdict. Two rows would count the question
    // twice and average a mark the teacher retracted into the estimate.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.score)).toBe(1);
  });

  it("reports the outcomes that cannot inform mastery at all", async () => {
    // A question filed under an outcome no concept covers is written,
    // approved, sat and marked — and then informs nothing. That is a designed
    // state while concepts are still being authored, but it must not be a
    // silent one, or the analytics page is empty six months later for reasons
    // nobody can explain.
    // Authored, not found: since the NCERT drafts every real outcome is covered,
    // so "some outcome is uncovered" stopped being a fact about the database.
    const { topicId } = await fixtureChapter({ label: "Uncovered" });
    await fixtureOutcome(topicId, "UNC");
    const coverage = await conceptCoverage();

    expect(coverage.concepts).toBeGreaterThan(0);
    expect(coverage.coveredOutcomes).toBeGreaterThan(0);
    expect(coverage.uncovered.length).toBeGreaterThan(0);
    expect(coverage.coveredOutcomes + coverage.uncovered.length).toBe(
      coverage.outcomes,
    );
    // Named, not just counted: a person has to be able to go and author one.
    expect(coverage.uncovered[0]!.code).toBeTruthy();
    expect(coverage.uncovered[0]!.chapter).toBeTruthy();
  });

  it("keeps one organisation's evidence out of another's", async () => {
    const world = await makeWorld();
    await sit(world, studentOf(world), true);

    const other = await makeWorld();
    const theirs = await withTenant(other.organizationId, (tx) =>
      tx.conceptEvidence.findMany(),
    );
    expect(theirs.every((row) => row.organizationId === other.organizationId)).toBe(true);
    expect(theirs.some((row) => row.studentUserId === world.studentId)).toBe(false);
  });
});

describe("the estimate", () => {
  it("refuses a number until there is enough evidence", async () => {
    const world = await makeWorld();
    await sit(world, studentOf(world), true);

    const mastery = await studentMastery(world.organizationId, world.studentId);
    expect(mastery).toHaveLength(1);
    // Two answers. Below the threshold, so there is no number at all — not a
    // small number, not a hedged one.
    expect(mastery[0]!.band).toBe("INSUFFICIENT");
    expect(mastery[0]!.estimate).toBeNull();
    expect(mastery[0]!.evidenceCount).toBe(2);
    expect(MIN_EVIDENCE).toBeGreaterThan(2);
  });

  it("produces a number once the evidence is there", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    // Three sittings of a two-question paper: six answers, one concept.
    for (let pass = 0; pass < 3; pass++) {
      await sit(world, studentOf(world), true);
    }

    const mastery = await studentMastery(world.organizationId, world.studentId);
    expect(mastery[0]!.evidenceCount).toBe(6);
    expect(mastery[0]!.band).not.toBe("INSUFFICIENT");
    expect(mastery[0]!.estimate).toBeGreaterThan(0.6);
    expect(mastery[0]!.conceptName).toBeTruthy();
  });

  it("puts a student who gets it wrong every time in a low band", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    for (let pass = 0; pass < 3; pass++) {
      await sit(world, studentOf(world), false);
    }

    const mastery = await studentMastery(world.organizationId, world.studentId);
    expect(mastery[0]!.estimate).toBeLessThan(0.4);
    expect(mastery[0]!.band).toBe("CRITICAL");
  });

  it("never stores a number the band refused to produce", async () => {
    const world = await makeWorld();
    await sit(world, studentOf(world), true);

    const rows = await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.findMany({ where: { studentUserId: world.studentId } }),
    );
    // Null in the column, not merely hidden by a caller. A number the product
    // refused to stand behind should not be sitting where the next feature's
    // join can find it and average it into something authoritative.
    expect(rows[0]!.band).toBe("INSUFFICIENT");
    expect(rows[0]!.estimate).toBeNull();
    expect(rows[0]!.confidence).toBeNull();
  });
});

describe("the ledger is the source of truth", () => {
  it("rebuilds to exactly what the incremental path produced", async () => {
    // The property the whole two-table split exists for. If a rebuild ever
    // disagreed with the running total, every past estimate would be
    // unverifiable and the ledger would be decoration.
    const world = await makeWorld({ maxAttempts: 3 });
    for (let pass = 0; pass < 3; pass++) {
      await sit(world, studentOf(world), pass !== 1);
    }

    const before = await studentMastery(world.organizationId, world.studentId);
    const now = new Date();

    await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.deleteMany({ where: { studentUserId: world.studentId } }),
    );
    await rebuildMastery(world.organizationId, now);

    const after = await studentMastery(world.organizationId, world.studentId);
    expect(after).toHaveLength(before.length);
    for (const [index, row] of after.entries()) {
      expect(row.conceptId).toBe(before[index]!.conceptId);
      expect(row.band).toBe(before[index]!.band);
      expect(row.evidenceCount).toBe(before[index]!.evidenceCount);
      expect(row.estimate).toBeCloseTo(before[index]!.estimate ?? 0, 2);
    }
  });

  it("adds no evidence when run twice", async () => {
    const world = await makeWorld();
    await sit(world, studentOf(world), true);

    const before = await evidenceRows(world);
    await rebuildMastery(world.organizationId);
    await rebuildMastery(world.organizationId);
    const after = await evidenceRows(world);

    expect(after).toHaveLength(before.length);
  });
});
