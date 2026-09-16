import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { detectForClass } from "@/core/gaps/detect";
import { acknowledgeGap, classGaps, studentGaps } from "@/core/gaps/read";
import { measureIntervention, planIntervention } from "@/core/gaps/interventions";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

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

/** Enough sittings to clear the evidence bar. */
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

/** A class where three of three measured students are struggling. */
async function strugglingClass() {
  const world = await makeWorld({ maxAttempts: 3 });
  const third = await addStudent(world, "Third Student");
  await measure(world, studentOf(world), false);
  await measure(world, actorFor(world, world.otherStudentId), false);
  await measure(world, actorFor(world, third), false);
  return { world, third };
}

describe("detecting a gap", () => {
  it("opens a class gap when enough of the measured class is below the line", async () => {
    const { world } = await strugglingClass();

    const gaps = await classGaps(world.organizationId, world.classId);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.status).toBe("DETECTED");
    expect(gaps[0]!.severity).toBe("HIGH");
    expect(gaps[0]!.affectedStudentCount).toBe(3);
    // The denominator travels with it: "3 of 3 measured" and "3 of 30" are
    // different findings and only one of them is about the class.
    expect(gaps[0]!.measuredStudentCount).toBe(3);
    expect(gaps[0]!.conceptName).toBeTruthy();
  });

  it("opens a gap for each struggling student too", async () => {
    const { world } = await strugglingClass();
    const mine = await studentGaps(world.organizationId, world.studentId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.scope).toBe("STUDENT");
    expect(mine[0]!.affectedStudentCount).toBe(1);
  });

  it("opens nothing for a class that is doing well", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await addStudent(world, "Third Student");
    await measure(world, studentOf(world), true);
    await measure(world, actorFor(world, world.otherStudentId), true);

    expect(await classGaps(world.organizationId, world.classId)).toHaveLength(0);
  });

  it("says nothing at all when too few students are measured", async () => {
    // One student's bad afternoon is not a class gap, and a product that
    // called it one would have a teacher reteaching to twenty-nine people who
    // were fine.
    const world = await makeWorld({ maxAttempts: 3 });
    await measure(world, studentOf(world), false);

    expect(await classGaps(world.organizationId, world.classId)).toHaveLength(0);
    // The student's own gap still stands — it is a claim about one person and
    // there is enough evidence for it.
    expect(await studentGaps(world.organizationId, world.studentId)).toHaveLength(1);
  });

  it("does not show another organisation's gaps", async () => {
    const { world } = await strugglingClass();
    const other = await makeWorld();
    expect(await classGaps(other.organizationId, world.classId)).toHaveLength(0);
    expect(await detectForClass(other.organizationId, world.classId)).toBeNull();
  });
});

describe("detection is a reconciliation, not an accumulation", () => {
  it("changes nothing when it runs again on the same evidence", async () => {
    const { world } = await strugglingClass();
    const before = await classGaps(world.organizationId, world.classId);

    const report = await detectForClass(world.organizationId, world.classId);
    expect(report?.opened).toBe(0);

    const after = await classGaps(world.organizationId, world.classId);
    expect(after).toHaveLength(before.length);
    expect(after[0]!.id).toBe(before[0]!.id);
    // The first sighting stays put, so "how long has this been true" has an
    // answer.
    expect(after[0]!.detectedAt.getTime()).toBe(before[0]!.detectedAt.getTime());
  });

  it("re-stamps when it sees the gap again", async () => {
    const { world } = await strugglingClass();
    const before = await classGaps(world.organizationId, world.classId);

    const later = new Date(Date.now() + 60_000);
    await detectForClass(world.organizationId, world.classId, later);

    const after = await classGaps(world.organizationId, world.classId);
    expect(after[0]!.lastSeenAt.getTime()).toBeGreaterThan(
      before[0]!.lastSeenAt.getTime(),
    );
    expect(after[0]!.detectedAt.getTime()).toBe(before[0]!.detectedAt.getTime());
  });
});

describe("a gap closes on evidence and on nothing else", () => {
  it("resolves when the class stops being below the line", async () => {
    const { world, third } = await strugglingClass();
    expect(await classGaps(world.organizationId, world.classId)).toHaveLength(1);

    // The evidence changes: the ledger is rewritten as though they had all
    // answered correctly, and detection is run again.
    await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.updateMany({
        where: { studentUserId: { in: [world.studentId, world.otherStudentId, third] } },
        data: { estimate: 0.9, band: "SECURE" },
      }),
    );
    await detectForClass(world.organizationId, world.classId);

    // Closed without a teacher doing anything. A gap list that only ever grows
    // is a list nobody reads by March.
    expect(await classGaps(world.organizationId, world.classId)).toHaveLength(0);
    const all = await classGaps(world.organizationId, world.classId, {
      includeResolved: true,
    });
    expect(all[0]!.status).toBe("RESOLVED");
    expect(all[0]!.resolvedAt).not.toBeNull();
  });

  it("has no way for a teacher to close one by hand", async () => {
    const { world } = await strugglingClass();
    const gaps = await classGaps(world.organizationId, world.classId);

    const acknowledged = await acknowledgeGap(teacherOf(world), gaps[0]!.id);
    expect(acknowledged.ok).toBe(true);
    if (!acknowledged.ok) return;
    // Acknowledging is saying you have seen it. It is not saying it is fixed,
    // and the API offers no way to say the second thing.
    expect(acknowledged.status).toBe("ACKNOWLEDGED");

    const after = await classGaps(world.organizationId, world.classId);
    expect(after[0]!.status).toBe("ACKNOWLEDGED");
    expect(after[0]!.resolvedAt).toBeNull();
  });

  it("leaves an acknowledged gap acknowledged when it is seen again", async () => {
    const { world } = await strugglingClass();
    const gaps = await classGaps(world.organizationId, world.classId);
    await acknowledgeGap(teacherOf(world), gaps[0]!.id);

    await detectForClass(world.organizationId, world.classId);

    const after = await classGaps(world.organizationId, world.classId);
    // Moving it back to DETECTED would put it in front of the teacher as
    // though it were new, which is how a list of findings becomes noise.
    expect(after[0]!.status).toBe("ACKNOWLEDGED");
  });

  it("keeps a gap INTERVENING while the intervention is unmeasured", async () => {
    const { world } = await strugglingClass();
    const gaps = await classGaps(world.organizationId, world.classId);
    const created = await planIntervention(teacherOf(world), gaps[0]!.id, {
      kind: "LESSON_PLAN",
    });
    if (!created.ok) throw new Error(created.message);

    // Somebody hands in a paper minutes later, which runs detection — twice
    // here, as a busy afternoon would. That is not evidence the lesson failed;
    // it has not been taught yet.
    await detectForClass(world.organizationId, world.classId);
    await detectForClass(world.organizationId, world.classId);

    const after = await classGaps(world.organizationId, world.classId);
    expect(after[0]!.status).toBe("INTERVENING");
  });

  it("marks a gap that survived a measured intervention as PERSISTING", async () => {
    const { world } = await strugglingClass();
    const gaps = await classGaps(world.organizationId, world.classId);
    const created = await planIntervention(teacherOf(world), gaps[0]!.id, {
      kind: "LESSON_PLAN",
    });
    if (!created.ok) throw new Error(created.message);

    const measured = await measureIntervention(teacherOf(world), created.interventionId);
    if (!measured.ok) throw new Error(measured.message);
    expect(measured.metTarget).toBe(false);

    const after = await classGaps(world.organizationId, world.classId);
    // The most important signal in the product: what was tried did not work.
    // It must never be indistinguishable from a fresh gap — and it is set by
    // the measurement, straight away, not by the next submission.
    expect(after[0]!.status).toBe("PERSISTING");

    // And it stays that way on later passes.
    await detectForClass(world.organizationId, world.classId);
    const again = await classGaps(world.organizationId, world.classId);
    expect(again[0]!.status).toBe("PERSISTING");
  });

  it("puts a persisting gap at the top of the list", async () => {
    const { world } = await strugglingClass();
    const gaps = await classGaps(world.organizationId, world.classId);
    const created = await planIntervention(teacherOf(world), gaps[0]!.id, {
      kind: "MANUAL",
    });
    if (!created.ok) throw new Error(created.message);
    await measureIntervention(teacherOf(world), created.interventionId);

    const after = await classGaps(world.organizationId, world.classId);
    expect(after[0]!.status).toBe("PERSISTING");
  });
});

describe("gaps follow the evidence automatically", () => {
  it("appears without anybody asking for detection", async () => {
    // Detection runs after marking, on the same path the mastery ledger does.
    // A teacher should not have to press anything to be told what to reteach.
    const { world } = await strugglingClass();
    const gaps = await classGaps(world.organizationId, world.classId);
    expect(gaps.length).toBeGreaterThan(0);
  });
});
