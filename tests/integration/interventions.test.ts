import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { approveQuestion, createQuestion } from "@/core/questions";
import { classGaps, gapSummary } from "@/core/gaps/read";
import { detectForClass } from "@/core/gaps/detect";
import {
  listInterventions,
  measureIntervention,
  planIntervention,
} from "@/core/gaps/interventions";
import { buildRemedial, planRemedial } from "@/core/gaps/remedial";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import {
  makeWorld,
  studentOf,
  teacherOf,
  type World,
} from "./support/world";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

const actorFor = (world: World, userId: string) => ({
  organizationId: world.organizationId,
  userId,
});

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
}

async function measure(
  world: World,
  actor: { organizationId: string; userId: string },
  correct: boolean,
) {
  for (let pass = 0; pass < 3; pass++) await sit(world, actor, correct);
}

async function addStudent(world: World, name: string): Promise<string> {
  const userId = randomUUID();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({
      data: [{ id: userId, fullName: `${name} ${userId.slice(0, 6)}`, status: "ACTIVE" }],
    });
    await tx.membership.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          userId,
          role: "STUDENT",
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      ],
    });
    await tx.classEnrolment.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          classId: world.classId,
          studentUserId: userId,
          status: "ACTIVE",
        },
      ],
    });
  });
  return userId;
}

/** A class where three of three measured students are below the line. */
async function classWithAGap() {
  const world = await makeWorld({ maxAttempts: 3 });
  const third = await addStudent(world, "Third Student");
  await measure(world, studentOf(world), false);
  await measure(world, actorFor(world, world.otherStudentId), false);
  await measure(world, actorFor(world, third), false);

  const gaps = await classGaps(world.organizationId, world.classId);
  if (gaps.length !== 1) throw new Error(`expected one gap, got ${gaps.length}`);
  return { world, third, gap: gaps[0]! };
}

/** Enough approved questions on the gap's outcome to build a paper from. */
async function stockTheBank(
  world: World,
  count: number,
  pattern: readonly ("EASY" | "MEDIUM" | "HARD")[] = ["EASY", "EASY", "MEDIUM", "MEDIUM", "HARD"],
) {
  for (let index = 0; index < count; index++) {
    const question = await createQuestion(teacherOf(world), {
      type: "MCQ",
      subjectId: world.subjectId,
      chapterId: world.chapterId,
      difficulty: pattern[index % pattern.length]!,
      marks: 1,
      stem: `Remedial practice ${index} — ${textToken()}`,
      options: [
        { key: "A", text: "AA", isCorrect: true },
        { key: "B", text: "SSS", isCorrect: false },
      ],
      explanation: "Because the third angle follows.",
      outcomeIds: [world.outcomeId],
    });
    if (!question.ok) throw new Error("stocking failed");
    await approveQuestion(teacherOf(world), question.id);
  }
}

describe("the baseline is stamped once and never moves", () => {
  it("records the mastery, the headcount and the target at creation", async () => {
    const { world, gap } = await classWithAGap();

    const created = await planIntervention(teacherOf(world), gap.id, {
      kind: "LESSON_PLAN",
      note: "Reteach with the ladder diagram on Monday.",
    });
    if (!created.ok) throw new Error(created.message);

    expect(created.baseline).toBeCloseTo(gap.meanEstimate, 3);
    // The target clears the threshold that made this a gap. An intervention
    // that can "succeed" while the gap stays open measures nothing.
    expect(created.target).toBeGreaterThan(0.6);

    const [row] = await listInterventions(world.organizationId);
    expect(row!.baselineStudentCount).toBe(gap.affectedStudentCount);
    expect(row!.conceptName).toBe(gap.conceptName);
    // Not measured yet, so not zero. Null is the only honest answer.
    expect(row!.outcomeMastery).toBeNull();
    expect(row!.delta).toBeNull();
    expect(row!.metTarget).toBeNull();
  });

  it("keeps the stamp when the mastery underneath it changes", async () => {
    const { world, third, gap } = await classWithAGap();
    const created = await planIntervention(teacherOf(world), gap.id, {
      kind: "MANUAL",
    });
    if (!created.ok) throw new Error(created.message);

    // The lesson happens; the ledger moves.
    await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.updateMany({
        where: {
          conceptId: gap.conceptId,
          studentUserId: { in: [world.studentId, world.otherStudentId, third] },
        },
        data: { estimate: 0.82, band: "SECURE" },
      }),
    );

    const [row] = await listInterventions(world.organizationId);
    // This is the whole invariant. If the baseline tracked current mastery,
    // every intervention would show zero improvement forever.
    expect(row!.baselineMastery).toBeCloseTo(created.baseline, 3);
  });

  it("puts the gap into INTERVENING so a survivor reads as PERSISTING", async () => {
    const { world, gap } = await classWithAGap();
    await planIntervention(teacherOf(world), gap.id, { kind: "PRACTICE_SET" });

    const [after] = await classGaps(world.organizationId, world.classId);
    expect(after!.status).toBe("INTERVENING");
  });

  it("refuses a second open intervention on the same gap", async () => {
    const { world, gap } = await classWithAGap();
    await planIntervention(teacherOf(world), gap.id, { kind: "LESSON_PLAN" });

    const second = await planIntervention(teacherOf(world), gap.id, {
      kind: "PRACTICE_SET",
    });
    // Two at once and the improvement belongs to neither.
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(/already something in progress/i);
  });
});

describe("measuring", () => {
  it("records an improvement against the stamp", async () => {
    const { world, third, gap } = await classWithAGap();
    const created = await planIntervention(teacherOf(world), gap.id, {
      kind: "LESSON_PLAN",
    });
    if (!created.ok) throw new Error(created.message);

    await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.updateMany({
        where: {
          conceptId: gap.conceptId,
          studentUserId: { in: [world.studentId, world.otherStudentId, third] },
        },
        data: { estimate: 0.78, band: "SECURE" },
      }),
    );

    const measured = await measureIntervention(
      teacherOf(world),
      created.interventionId,
    );
    if (!measured.ok) throw new Error(measured.message);

    expect(measured.outcome).toBeCloseTo(0.78, 2);
    expect(measured.delta).toBeGreaterThan(0);
    expect(measured.metTarget).toBe(true);
  });

  it("records a failure just as readily", async () => {
    // The signal the product exists to produce. A measure pass that quietly
    // declined to record a disappointing result would make every number on the
    // reports page meaningless.
    const { world, gap } = await classWithAGap();
    const created = await planIntervention(teacherOf(world), gap.id, {
      kind: "MANUAL",
    });
    if (!created.ok) throw new Error(created.message);

    const measured = await measureIntervention(
      teacherOf(world),
      created.interventionId,
    );
    if (!measured.ok) throw new Error(measured.message);

    expect(measured.metTarget).toBe(false);
    expect(measured.outcome).toBeCloseTo(created.baseline, 2);

    const [row] = await listInterventions(world.organizationId);
    expect(row!.status).toBe("MEASURED");
    expect(row!.metTarget).toBe(false);
  });

  it("will not measure the same thing twice", async () => {
    const { world, gap } = await classWithAGap();
    const created = await planIntervention(teacherOf(world), gap.id, {
      kind: "MANUAL",
    });
    if (!created.ok) throw new Error(created.message);

    await measureIntervention(teacherOf(world), created.interventionId);
    const again = await measureIntervention(teacherOf(world), created.interventionId);
    // A result that can be re-taken until it is flattering is not a result.
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.message).toMatch(/already been measured/i);
  });

  it("refuses rather than call an unmeasurable group a zero", async () => {
    const { world, third, gap } = await classWithAGap();
    const created = await planIntervention(teacherOf(world), gap.id, {
      kind: "MANUAL",
    });
    if (!created.ok) throw new Error(created.message);

    await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.updateMany({
        where: {
          conceptId: gap.conceptId,
          studentUserId: { in: [world.studentId, world.otherStudentId, third] },
        },
        data: { estimate: null, band: "INSUFFICIENT" },
      }),
    );

    const measured = await measureIntervention(
      teacherOf(world),
      created.interventionId,
    );
    expect(measured.ok).toBe(false);
    if (!measured.ok) expect(measured.message).toMatch(/enough evidence/i);

    // And nothing was written, so it can still be measured properly later.
    const [row] = await listInterventions(world.organizationId);
    expect(row!.status).toBe("ACTIVE");
    expect(row!.outcomeMastery).toBeNull();
  });
});

describe("the remedial paper", () => {
  it("refuses a bank too thin to read anything from, and says how thin", async () => {
    const { world, gap } = await classWithAGap();

    // The world ships two approved questions on this outcome. Four is the floor.
    const plan = await planRemedial(world.organizationId, gap.id);
    if ("error" in plan) throw new Error(plan.error);

    expect(plan.feasible).toBe(false);
    expect(plan.problems[0]).toMatch(/2 approved questions/);
    expect(plan.problems[0]).toContain(plan.conceptName);

    const built = await buildRemedial(teacherOf(world), gap.id, {
      opensAt: new Date(Date.now() + 60_000),
      closesAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    expect(built.ok).toBe(false);
  });

  it("calibrates down for a group that cannot do it at all", async () => {
    const { world, gap } = await classWithAGap();
    await stockTheBank(world, 8);

    const plan = await planRemedial(world.organizationId, gap.id);
    if ("error" in plan) throw new Error(plan.error);

    expect(plan.feasible).toBe(true);
    expect(plan.meanEstimate).toBeLessThan(0.6);
    // They are a long way behind; nothing hard.
    expect(plan.mix.HARD).toBe(0);
    expect(plan.mix.EASY).toBeGreaterThan(plan.mix.MEDIUM);

    // Generous but not absurd: half again as long as the paper is worth. Eight
    // one-mark MCQs is twenty minutes of work, not an eighty-minute exam.
    expect(plan.durationMinutes).toBeGreaterThanOrEqual(15);
    expect(plan.durationMinutes).toBeLessThanOrEqual(plan.totalMarks * 4);
  });

  it("builds, publishes and assigns it to those students only", async () => {
    const { world, third, gap } = await classWithAGap();
    await stockTheBank(world, 8);

    // A fourth student who is fine. They must not be given the paper.
    const fine = await addStudent(world, "Doing Fine");
    await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.create({
        data: {
          id: randomUUID(),
          organizationId: world.organizationId,
          studentUserId: fine,
          conceptId: gap.conceptId,
          estimate: 0.88,
          band: "SECURE",
          evidenceCount: 6,
          effectiveEvidence: 6,
          lastEvidenceAt: new Date(),
        },
      }),
    );

    const built = await buildRemedial(teacherOf(world), gap.id, {
      opensAt: new Date(Date.now() + 60_000),
      closesAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    if (!built.ok) throw new Error(built.message);

    expect(built.questionCount).toBeGreaterThanOrEqual(4);
    expect(built.studentCount).toBe(3);

    const assessment = await withTenant(world.organizationId, (tx) =>
      tx.assessment.findFirstOrThrow({ where: { id: built.assessmentId } }),
    );
    // Published, so the question versions are frozen and what a student saw
    // can be reconstructed afterwards.
    expect(assessment.status).toBe("PUBLISHED");
    expect(assessment.title).toContain(gap.conceptName);

    const targets = await withTenant(world.organizationId, (tx) =>
      tx.assignmentTarget.findMany({ where: { assignmentId: built.assignmentId } }),
    );
    const targeted = targets.map((target) => target.studentUserId).sort();
    expect(targeted).toEqual(
      [world.studentId, world.otherStudentId, third].sort(),
    );
    expect(targeted).not.toContain(fine);

    // Every question on it is on the concept the gap is about — the sitting is
    // a clean second reading, not a general revision paper.
    const rows = await withTenant(world.organizationId, (tx) =>
      tx.assessmentQuestion.findMany({
        where: { assessmentId: built.assessmentId },
        select: { questionId: true, questionVersionId: true },
      }),
    );
    expect(rows.every((row) => row.questionVersionId !== null)).toBe(true);

    const outcomeLinks = await withTenant(world.organizationId, (tx) =>
      tx.questionOutcome.findMany({
        where: { questionId: { in: rows.map((row) => row.questionId) } },
        select: { questionId: true, learningOutcomeId: true },
      }),
    );
    const conceptOutcomes = await prisma.conceptOutcome.findMany({
      where: { conceptId: gap.conceptId },
      select: { learningOutcomeId: true },
    });
    const allowed = new Set(conceptOutcomes.map((row) => row.learningOutcomeId));
    for (const row of rows) {
      const links = outcomeLinks.filter((link) => link.questionId === row.questionId);
      expect(links.some((link) => allowed.has(link.learningOutcomeId))).toBe(true);
    }
  });

  it("stamps the baseline as part of the same click", async () => {
    const { world, gap } = await classWithAGap();
    await stockTheBank(world, 8);

    const built = await buildRemedial(teacherOf(world), gap.id, {
      opensAt: new Date(Date.now() + 60_000),
      closesAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    if (!built.ok) throw new Error(built.message);

    const [row] = await listInterventions(world.organizationId);
    expect(row!.id).toBe(built.interventionId);
    expect(row!.kind).toBe("REMEDIAL_ASSESSMENT");
    expect(row!.baselineMastery).toBeCloseTo(gap.meanEstimate, 2);
    expect(row!.baselineStudentCount).toBe(3);

    // An assessment built from a gap and not measured against it is just
    // another paper.
    const stored = await withTenant(world.organizationId, (tx) =>
      tx.intervention.findFirstOrThrow({ where: { id: built.interventionId } }),
    );
    expect(stored.assessmentId).toBe(built.assessmentId);
    expect(stored.assignmentId).toBe(built.assignmentId);

    const [after] = await classGaps(world.organizationId, world.classId);
    expect(after!.status).toBe("INTERVENING");
  });

  it("will not build a second one while the first is unmeasured", async () => {
    const { world, gap } = await classWithAGap();
    await stockTheBank(world, 8);

    const window = {
      opensAt: new Date(Date.now() + 60_000),
      closesAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    };
    const first = await buildRemedial(teacherOf(world), gap.id, window);
    expect(first.ok).toBe(true);

    const second = await buildRemedial(teacherOf(world), gap.id, window);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(/already something in progress/i);
  });
});

describe("a success is measurable too", () => {
  it("keeps an open intervention measurable after the evidence closes its gap", async () => {
    const { world, third, gap } = await classWithAGap();
    const created = await planIntervention(teacherOf(world), gap.id, {
      kind: "LESSON_PLAN",
    });
    if (!created.ok) throw new Error(created.message);

    // The lesson works; the next pass closes the gap.
    await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.updateMany({
        where: {
          conceptId: gap.conceptId,
          studentUserId: { in: [world.studentId, world.otherStudentId, third] },
        },
        data: { estimate: 0.82, band: "SECURE" },
      }),
    );
    await detectForClass(world.organizationId, world.classId);
    expect(await classGaps(world.organizationId, world.classId)).toHaveLength(0);

    // Still there, still open, and counted where a teacher will see it. It
    // used to disappear with the gap, so only failures could ever be recorded.
    const [row] = await listInterventions(world.organizationId, world.classId);
    expect(row!.id).toBe(created.interventionId);
    expect(row!.status).toBe("ACTIVE");
    const summary = await gapSummary(world.organizationId);
    expect(summary.toMeasure.onClosedGaps).toBe(1);
    expect(summary.toMeasure.classIds).toContain(world.classId);

    const measured = await measureIntervention(teacherOf(world), created.interventionId);
    if (!measured.ok) throw new Error(measured.message);
    expect(measured.metTarget).toBe(true);

    // Measuring does not reopen a closed gap.
    const all = await classGaps(world.organizationId, world.classId, { includeResolved: true });
    expect(all[0]!.status).toBe("RESOLVED");
  });

  it("reports the original cohort beside the outcome", async () => {
    const { world, gap } = await classWithAGap();
    const created = await planIntervention(teacherOf(world), gap.id, { kind: "MANUAL" });
    if (!created.ok) throw new Error(created.message);

    const measured = await measureIntervention(teacherOf(world), created.interventionId);
    if (!measured.ok) throw new Error(measured.message);

    // The three who were below the line when it started, re-derived from the
    // ledger, and read again. Nothing changed, so they read about the same.
    expect(measured.cohort.students).toBe(3);
    expect(measured.cohort.measured).toBe(3);
    expect(measured.cohort.source).toBe("ledger");
    expect(measured.cohort.mean).not.toBeNull();
    expect(Math.abs(measured.cohort.mean! - measured.outcome)).toBeLessThan(0.05);

    const [row] = await listInterventions(world.organizationId);
    expect(row!.cohort?.students).toBe(3);
  });
});

describe("the remedial preview describes the paper it will build", () => {
  it("leaves out questions these students have already answered", async () => {
    const { world, gap } = await classWithAGap();
    await stockTheBank(world, 8);

    const plan = await planRemedial(world.organizationId, gap.id);
    if ("error" in plan) throw new Error(plan.error);

    // The world's own two questions are the paper they all sat three times.
    const chosen = plan.chosen.map((item) => item.questionId);
    for (const seen of world.questionIds) expect(chosen).not.toContain(seen);
    expect(plan.reused).toBe(0);
    expect(plan.chosen.length).toBe(8);
  });

  it("counts what it chose, and says when the bank has no easy questions", async () => {
    const { world, gap } = await classWithAGap();
    // A group this far behind wants mostly easy questions; the bank has none.
    await stockTheBank(world, 6, ["MEDIUM", "HARD"]);

    const plan = await planRemedial(world.organizationId, gap.id);
    if ("error" in plan) throw new Error(plan.error);

    expect(plan.mix.EASY).toBeGreaterThan(0);
    expect(plan.chosenByDifficulty.EASY).toBe(0);
    const total =
      plan.chosenByDifficulty.EASY + plan.chosenByDifficulty.MEDIUM + plan.chosenByDifficulty.HARD;
    expect(total).toBe(plan.chosen.length);
    expect(plan.notes.join(" ")).toMatch(/no easy questions/i);

    // And the build puts exactly that on the paper.
    const built = await buildRemedial(teacherOf(world), gap.id, {
      opensAt: new Date(Date.now() + 60_000),
      closesAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    if (!built.ok) throw new Error(built.message);
    expect(built.questionCount).toBe(plan.chosen.length);
  });

  it("falls back to questions they have met only to reach the floor, and says so", async () => {
    const { world, gap } = await classWithAGap();
    await stockTheBank(world, 3);

    const plan = await planRemedial(world.organizationId, gap.id);
    if ("error" in plan) throw new Error(plan.error);

    expect(plan.feasible).toBe(true);
    expect(plan.chosen.length).toBe(4);
    expect(plan.reused).toBe(1);
    expect(plan.notes.join(" ")).toMatch(/seen before/i);
  });
});

describe("tenancy", () => {
  it("shows another organisation nothing", async () => {
    const { world, gap } = await classWithAGap();
    await planIntervention(teacherOf(world), gap.id, { kind: "MANUAL" });

    const other = await makeWorld();
    expect(await listInterventions(other.organizationId)).toHaveLength(0);

    const reached = await planIntervention(teacherOf(other), gap.id, {
      kind: "MANUAL",
    });
    expect(reached.ok).toBe(false);

    const planned = await planRemedial(other.organizationId, gap.id);
    expect("error" in planned).toBe(true);
  });
});
