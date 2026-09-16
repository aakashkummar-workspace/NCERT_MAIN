import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { createClass } from "@/core/classes";
import { detectForClass } from "@/core/gaps/detect";
import { classGaps } from "@/core/gaps/read";
import { measureIntervention, planIntervention } from "@/core/gaps/interventions";
import { recomputeMastery } from "@/core/mastery/ledger";
import { batches } from "@/core/institute/batches";
import {
  instituteAnalytics,
  INTERVENTION_STALE_DAYS,
  MIN_MEASURED,
} from "@/core/institute/analytics";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;

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

/** Enough sittings to clear the evidence bar. */
async function measure(
  world: World,
  actor: { organizationId: string; userId: string },
  correct: boolean,
) {
  for (let pass = 0; pass < 3; pass++) await sit(world, actor, correct);
}

async function addStudentTo(world: World, classId: string, name: string) {
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
          classId,
          studentUserId: userId,
          status: "ACTIVE",
        },
      ],
    });
  });
  return userId;
}

/**
 * Evidence, then a recomputation — never a hand-written estimate.
 *
 * `student_concept_mastery` is a cache derived from the ledger, and a value
 * typed straight into it cannot be reproduced from the evidence, which is the
 * one property the two-table split exists for. So this fixture writes the
 * ledger rows and lets `recomputeMastery` produce the number, exactly as the
 * submit path does.
 */
async function giveEvidence(
  world: World,
  studentUserId: string,
  conceptId: string,
  score: number,
  rows = 6,
) {
  await withTenant(world.organizationId, async (tx) => {
    await tx.conceptEvidence.createMany({
      data: Array.from({ length: rows }, (_, index) => ({
        id: randomUUID(),
        organizationId: world.organizationId,
        studentUserId,
        conceptId,
        source: "ASSESSMENT" as const,
        score,
        difficulty: "MEDIUM" as const,
        weight: 1,
        observedAt: new Date(Date.now() - index * 3600_000),
      })),
    });
    await recomputeMastery(tx, world.organizationId, studentUserId, conceptId);
  });
}

/** A class where three of three measured students are behind. */
async function strugglingClass() {
  const world = await makeWorld({ maxAttempts: 3 });
  const third = await addStudentTo(world, world.classId, "Third Student");
  await measure(world, studentOf(world), false);
  await measure(world, actorFor(world, world.otherStudentId), false);
  await measure(world, actorFor(world, third), false);

  const rows = await withTenant(world.organizationId, (tx) =>
    tx.studentConceptMastery.findMany({ where: { studentUserId: world.studentId } }),
  );
  const conceptId = rows[0]!.conceptId;

  return { world, third, conceptId };
}

/** A second batch in the same institute, with its own students and evidence. */
async function secondClass(world: World, conceptId: string, score: number) {
  const subject = await prisma.subject.findFirstOrThrow({
    where: { id: world.subjectId },
  });
  const className = `Class 10-B ${randomUUID().slice(0, 4)}`;
  const klass = await createClass(teacherOf(world), {
    name: className,
    gradeId: subject.gradeId,
    subjectId: world.subjectId,
    academicYear: "2026-27",
  });

  const students: string[] = [];
  for (let index = 0; index < MIN_MEASURED; index++) {
    const studentId = await addStudentTo(world, klass.id, `B${index}`);
    await giveEvidence(world, studentId, conceptId, score);
    students.push(studentId);
  }
  return { classId: klass.id, className, students };
}

describe("cohorts carry their denominators", () => {
  it("agrees with the batches table about a cohort, number for number", async () => {
    const { world } = await strugglingClass();

    const [table, analytics] = await Promise.all([
      batches(world.organizationId),
      instituteAnalytics(world.organizationId),
    ]);

    const fromTable = table.find((row) => row.classId === world.classId)!;
    const fromAnalytics = analytics.cohorts.find(
      (row) => row.classId === world.classId,
    )!;

    // Two screens disagreeing about a cohort's figure — or about whether it
    // exists at all — is worse than either rule on its own. Both compute the
    // mean per student first and then across students, and this is what keeps
    // them honest when one of them is edited.
    expect(fromAnalytics.measured).toBe(fromTable.measured);
    expect(fromAnalytics.students).toBe(fromTable.students);
    expect(fromAnalytics.meanEstimate).toBe(fromTable.meanEstimate);
  });

  it("refuses a mean below the measured threshold and says what to do instead", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await measure(world, studentOf(world), false);

    const analytics = await instituteAnalytics(world.organizationId);
    const cohort = analytics.cohorts.find((row) => row.classId === world.classId)!;

    // One measured student of two is not a cohort. Arithmetically correct,
    // factually false.
    expect(cohort.meanEstimate).toBeNull();
    expect(cohort.struggling).toBeNull();
    expect(cohort.sentence).toContain("1 of 2");

    const insight = analytics.insights.find(
      (row) => row.kind === "cohort-unmeasurable",
    )!;
    // The refusal, turned into something an owner can do this week.
    expect(insight).toBeDefined();
    expect(insight.message).toContain("1 of 2");
    expect(insight.action).toMatch(/paper/i);
    expect(insight.href).toContain(world.classId);
  });

  it("never carries a percentage without the students behind it", async () => {
    const { world } = await strugglingClass();
    const analytics = await instituteAnalytics(world.organizationId);

    for (const cohort of analytics.cohorts) {
      if (cohort.sentence.includes("%")) {
        expect(cohort.sentence).toMatch(/of \d+ students/);
      }
    }
    for (const insight of analytics.insights) {
      if (insight.message.includes("%")) expect(insight.message).toMatch(/\bof\b/);
    }
  });
});

describe("a concept weak in more than one class", () => {
  it("calls it systemic and sends the owner at the material, not at one room", async () => {
    const { world, conceptId } = await strugglingClass();
    const second = await secondClass(world, conceptId, 0.1);

    const analytics = await instituteAnalytics(world.organizationId);
    const concept = analytics.concepts.find((row) => row.conceptId === conceptId)!;

    expect(concept).toBeDefined();
    expect(concept.verdict).toBe("systemic");
    expect(concept.weakClasses).toBe(2);
    expect(concept.comparable).toBe(2);
    // Both classes are named with what each figure was computed over.
    expect(concept.classes.map((cell) => cell.classId).sort()).toEqual(
      [world.classId, second.classId].sort(),
    );
    for (const cell of concept.classes) {
      expect(cell.measured).toBeGreaterThanOrEqual(MIN_MEASURED);
      expect(cell.enrolled).toBeGreaterThanOrEqual(cell.measured);
    }

    const insight = analytics.insights.find(
      (row) => row.kind === "concept-systemic",
    )!;
    expect(insight.severity).toBe("high");
    expect(insight.action).toMatch(/more than one room/i);
    expect(insight.href).toContain("/gaps");
  });

  it("calls it that room when the other batch is fine", async () => {
    const { world, conceptId } = await strugglingClass();
    await secondClass(world, conceptId, 1);

    const analytics = await instituteAnalytics(world.organizationId);
    const concept = analytics.concepts.find((row) => row.conceptId === conceptId)!;

    expect(concept.verdict).toBe("localised");
    expect(concept.weakClasses).toBe(1);
    // Weak in one room and fine in the other is a different problem with a
    // different answer, and the product must not offer the same one.
    expect(concept.action).toMatch(/that room/i);
    expect(analytics.insights.some((row) => row.kind === "concept-systemic")).toBe(
      false,
    );
  });

  it("gives no verdict at all when only one batch has evidence", async () => {
    const { world, conceptId } = await strugglingClass();
    // A second class with students and no marked work — the commonest real
    // state, and the one where a comparison would be invented.
    const subject = await prisma.subject.findFirstOrThrow({
      where: { id: world.subjectId },
    });
    const klass = await createClass(teacherOf(world), {
      name: `Class 10-C ${randomUUID().slice(0, 4)}`,
      gradeId: subject.gradeId,
      subjectId: world.subjectId,
      academicYear: "2026-27",
    });
    await addStudentTo(world, klass.id, "C0");

    const analytics = await instituteAnalytics(world.organizationId);
    const concept = analytics.concepts.find((row) => row.conceptId === conceptId)!;

    expect(concept.comparable).toBe(1);
    expect(concept.verdict).toBe("not-comparable");
    expect(concept.meanAcrossClasses).toBeNull();
    expect(analytics.spread.gapPoints).toBeNull();
  });
});

describe("improvement is only claimed against a stamped baseline", () => {
  it("refuses when nothing has been tried", async () => {
    const { world } = await strugglingClass();
    const analytics = await instituteAnalytics(world.organizationId);

    expect(analytics.improvement.claim.claimed).toBe(false);
    if (!analytics.improvement.claim.claimed) {
      expect(analytics.improvement.claim.reason).toBe("nothing-planned");
    }
  });

  it("reports the measurement against the stamp, not against today's number", async () => {
    const { world, third } = await strugglingClass();
    await detectForClass(world.organizationId, world.classId);
    const gaps = await classGaps(world.organizationId, world.classId);
    const gapId = gaps[0]!.id;

    const planned = await planIntervention(
      { ...teacherOf(world), role: "OWNER" },
      gapId,
      { kind: "LESSON_PLAN" },
    );
    if (!planned.ok) throw new Error(planned.message);

    // The class improves after the baseline was stamped.
    await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.updateMany({
        where: {
          studentUserId: { in: [world.studentId, world.otherStudentId, third] },
        },
        data: { estimate: 0.9, band: "SECURE" },
      }),
    );

    const measured = await measureIntervention(
      { ...teacherOf(world), role: "OWNER" },
      planned.interventionId,
    );
    expect(measured.ok).toBe(true);

    const analytics = await instituteAnalytics(world.organizationId);
    const row = analytics.improvement.measured.find(
      (each) => each.interventionId === planned.interventionId,
    )!;

    expect(row).toBeDefined();
    // The invariant the whole interventions table exists for: the baseline is
    // the number written down before the teaching, and moving mastery
    // underneath it does not move the claim.
    expect(row.baselineMastery).toBeCloseTo(planned.baseline, 3);
    expect(row.outcomeMastery).toBeCloseTo(0.9, 2);
    expect(row.change).toBeCloseTo(0.9 - planned.baseline, 2);
    expect(row.reachedTarget).toBe(true);
    // Both denominators travel with the claim.
    expect(row.sentence).toMatch(/students then and \d+ at the measurement/);

    // One measurement is a result about one class, never an institute trend.
    expect(analytics.improvement.claim.claimed).toBe(false);
    if (!analytics.improvement.claim.claimed) {
      expect(analytics.improvement.claim.reason).toBe("too-few-measured");
    }
  });

  it("raises an intervention nobody has measured", async () => {
    const { world } = await strugglingClass();
    await detectForClass(world.organizationId, world.classId);
    const gaps = await classGaps(world.organizationId, world.classId);

    const planned = await planIntervention(
      { ...teacherOf(world), role: "OWNER" },
      gaps[0]!.id,
      { kind: "LESSON_PLAN" },
    );
    if (!planned.ok) throw new Error(planned.message);

    await withTenant(world.organizationId, (tx) =>
      tx.intervention.update({
        where: { id: planned.interventionId },
        data: {
          createdAt: new Date(Date.now() - (INTERVENTION_STALE_DAYS + 10) * DAY),
        },
      }),
    );

    const analytics = await instituteAnalytics(world.organizationId);
    expect(analytics.improvement.unmeasured).toHaveLength(1);
    expect(analytics.improvement.unmeasured[0]!.days).toBeGreaterThanOrEqual(
      INTERVENTION_STALE_DAYS,
    );

    const insight = analytics.insights.find(
      (row) => row.kind === "intervention-unmeasured",
    )!;
    // An unmeasured intervention is an improvement claim nobody can check.
    expect(insight).toBeDefined();
    expect(insight.action).toMatch(/measure it/i);
  });
});

describe("nothing here can rank a teacher, and nothing is an institute score", () => {
  it("returns no teacher, by name or by id, anywhere in the payload", async () => {
    const { world, conceptId } = await strugglingClass();
    await secondClass(world, conceptId, 0.1);
    await detectForClass(world.organizationId, world.classId);

    const analytics = await instituteAnalytics(world.organizationId);
    const teacher = await withTenant(world.organizationId, (tx) =>
      tx.user.findFirstOrThrow({ where: { id: world.teacherId } }),
    );

    const serialised = JSON.stringify(analytics);
    // A cohort difference is a fact about students. It becomes a claim about a
    // person only if somebody joins it to the timetable, and there is nothing
    // in here to join it with — no teacher id, no name, no field that could
    // carry one later without this test failing.
    expect(serialised).not.toContain(world.teacherId);
    expect(serialised).not.toContain(teacher.fullName);
    expect(serialised).not.toMatch(
      /teacherUserId|teacherId|assignedById|createdById|ownerTeacherId|rank|league/i,
    );
  });

  it("has no single figure for the institute", async () => {
    const { world, conceptId } = await strugglingClass();
    await secondClass(world, conceptId, 0.1);

    const analytics = await instituteAnalytics(world.organizationId);

    // Pinned by name. Averaging across concepts produces a number that moves
    // when the syllabus moves, and it is exactly the number that would be
    // printed on a report and compared between branches — so there is nowhere
    // for one to appear without this failing.
    expect(Object.keys(analytics).sort()).toEqual([
      "cohorts",
      "concepts",
      "conceptsWithEvidence",
      "improvement",
      "insights",
      "spread",
    ]);
    // Every mastery figure that exists sits beside the students it was
    // computed over.
    for (const cohort of analytics.cohorts) {
      if (cohort.meanEstimate !== null) {
        expect(cohort.measured).toBeGreaterThanOrEqual(MIN_MEASURED);
      }
    }
    for (const concept of analytics.concepts) {
      for (const cell of concept.classes) {
        if (cell.meanEstimate !== null) {
          expect(cell.measured).toBeGreaterThanOrEqual(MIN_MEASURED);
        }
      }
    }
  });
});

describe("tenancy", () => {
  it("shows another institute nothing of this one", async () => {
    const { world, conceptId } = await strugglingClass();
    await secondClass(world, conceptId, 0.1);

    const other = await makeWorld();
    const analytics = await instituteAnalytics(other.organizationId);

    expect(analytics.cohorts.every((row) => row.classId !== world.classId)).toBe(true);
    const serialised = JSON.stringify(analytics);
    expect(serialised).not.toContain(world.classId);
    expect(serialised).not.toContain(world.studentId);
  });
});
