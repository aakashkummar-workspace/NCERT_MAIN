import { afterAll, describe, expect, it } from "vitest";
import { approveQuestion, createQuestion } from "@/core/questions";
import {
  assignPractice,
  cancelAssignedPractice,
  listForClass,
  openForStudent,
} from "@/core/practice/assigned";
import { answerPractice, getPractice, startPractice } from "@/core/practice";
import { PRACTICE_WEIGHT } from "@/core/practice/evidence";
import type { Response } from "@/core/attempts/score";
import { studyPlan } from "@/core/plan";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Practice a teacher asked for.
 *
 * The claims worth a database: the instruction is refused when the bank cannot
 * honour it, it reaches the student whose class it was set for and nobody
 * else, finishing it takes it off their list rather than leaving a tick, and
 * withdrawing one stops it appearing without taking back what was practised.
 *
 * And the one this feature must not break: nothing here produces a mark.
 */

/** Stock the bank with approved MCQs on the world's outcome. */
async function stock(world: World, count: number) {
  for (let index = 0; index < count; index++) {
    const question = await createQuestion(teacherOf(world), {
      type: "MCQ",
      subjectId: world.subjectId,
      chapterId: world.chapterId,
      difficulty: (["EASY", "MEDIUM", "HARD"] as const)[index % 3]!,
      marks: 1,
      stem: `Assigned practice question ${index} — ${textToken()}`,
      options: [
        { key: "A", text: "The right one", isCorrect: true },
        { key: "B", text: "The wrong one", isCorrect: false },
      ],
      explanation: `Because of the reason for question ${index}.`,
      outcomeIds: [world.outcomeId],
    });
    if (!question.ok) throw new Error("stocking failed");
    await approveQuestion(teacherOf(world), question.id);
  }
}

/**
 * The concept the world's outcome is already grouped under.
 *
 * Read, never authored: concepts carry no organization_id, so a concept a test
 * attaches to the shared seeded outcome is permanent, global, and splits the
 * evidence for every suite that uses this world.
 */
async function conceptOfWorld(world: World) {
  const link = await prisma.conceptOutcome.findFirstOrThrow({
    where: { learningOutcomeId: world.outcomeId },
    select: { conceptId: true },
  });
  return link.conceptId;
}

/** Work through every question in a set, correctly. */
async function finish(world: World, sessionId: string) {
  const actor = studentOf(world);
  for (let guard = 0; guard < 30; guard++) {
    const view = await getPractice(actor, sessionId);
    const open = view!.questions.find((question) => question.isCorrect === null);
    if (!open) return;
    const response: Response = { kind: "choice", keys: ["A"] };
    const result = await answerPractice(actor, open.practiceAnswerId, response);
    if (!result.ok || result.finished) return;
  }
  throw new Error("the set never finished");
}

/** A world with a stocked bank and the concept its questions reach. */
async function stocked(questions = 6) {
  const world = await makeWorld();
  await stock(world, questions);
  return { world, conceptId: await conceptOfWorld(world) };
}

describe("setting it", () => {
  it("refuses a count the bank cannot honour, and says how many it holds", async () => {
    // Four is the smallest set, so a bank of two cannot honour anything.
    const { world, conceptId } = await stocked(2);

    const result = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      questionCount: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("thin-bank");
    // The number, not "not enough questions": a teacher can act on the
    // first, and what was asked for sits beside it.
    expect(result.message).toMatch(/The bank holds \d+ practice questions? on /);
    expect(result.message).toMatch(/you asked for 10\./);
  });

  it("refuses an idea from another subject", async () => {
    const { world } = await stocked();
    // A concept from a different subject entirely — practice on it would file
    // its evidence under a syllabus these students are not measured on.
    const elsewhere = await prisma.conceptOutcome.findFirst({
      where: { outcome: { topic: { chapter: { subjectId: { not: world.subjectId } } } } },
      select: { conceptId: true },
    });
    if (!elsewhere) return; // nothing to test against in this database

    const result = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId: elsewhere.conceptId,
      questionCount: 4,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid");
  });

  it("refuses a class that is not this organization's", async () => {
    const { world, conceptId } = await stocked();
    const other = await makeWorld();
    const result = await assignPractice(teacherOf(other), {
      classId: world.classId,
      conceptId,
      questionCount: 4,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });

  it("leaves an audit row naming the class", async () => {
    const { world, conceptId } = await stocked();
    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      questionCount: 4,
    });
    expect(set.ok).toBe(true);

    const audits = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.findMany({ where: { action: "practice.assigned" } }),
    );
    expect(audits.length).toBe(1);
    expect(audits[0]!.entityId).toBe(world.classId);
  });
});

describe("what the student gets", () => {
  it("reaches the class it was set for, and nobody else", async () => {
    const { world, conceptId } = await stocked();
    const other = await makeWorld();

    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      questionCount: 5,
      note: "Before Thursday's lesson.",
    });
    if (!set.ok) throw new Error(set.message);

    const mine = await openForStudent(world.organizationId, world.studentId);
    expect(mine.map((row) => row.id)).toContain(set.id);
    const row = mine.find((item) => item.id === set.id)!;
    expect(row.state).toBe("TODO");
    expect(row.questionCount).toBe(5);
    expect(row.note).toBe("Before Thursday's lesson.");

    // Another organization's student sees nothing of it.
    const theirs = await openForStudent(other.organizationId, other.studentId);
    expect(theirs.map((item) => item.id)).not.toContain(set.id);
  });

  it("is a deadline item in the study plan, above the product's own suggestions", async () => {
    const { world, conceptId } = await stocked();
    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      questionCount: 4,
    });
    if (!set.ok) throw new Error(set.message);

    // Nothing has been measured about this student, so every OTHER kind of
    // item refuses — and the plan still has something to say, because somebody
    // asked for this rather than the product suggesting it.
    const plan = await studyPlan(studentOf(world));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const item = plan.items.find((row) => row.kind === "assigned-practice");
    expect(item).toBeDefined();
    expect(item!.deadline).toBe(true);
    expect(item!.href).toContain(set.id);
    // Never a mark, and never a scolding.
    expect(item!.why).toMatch(/teacher asked for 4 questions/);
    expect(item!.why).not.toMatch(/marks?\b/i);
  });

  it("drops off the list when it is done, rather than sitting there with a tick", async () => {
    const { world, conceptId } = await stocked();
    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      questionCount: 4,
    });
    if (!set.ok) throw new Error(set.message);

    const started = await startPractice(studentOf(world), {
      conceptId,
      questionCount: 4,
      source: "ASSIGNED",
      assignedPracticeId: set.id,
    });
    if (!started.ok) throw new Error(started.message);

    // Half way: still on the list, and carrying the session to carry on with.
    const midway = await openForStudent(world.organizationId, world.studentId);
    const open = midway.find((row) => row.id === set.id);
    expect(open?.state).toBe("IN_PROGRESS");
    expect(open?.sessionId).toBe(started.sessionId);

    await finish(world, started.sessionId);

    const after = await openForStudent(world.organizationId, world.studentId);
    expect(after.map((row) => row.id)).not.toContain(set.id);

    // It is still practice, so it writes evidence at the reduced weight — a
    // teacher asking for it does not make it a supervised paper.
    const evidence = await withTenant(world.organizationId, (tx) =>
      tx.conceptEvidence.findMany({
        where: { studentUserId: world.studentId, source: "PRACTICE" },
      }),
    );
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((row) => Number(row.weight) <= PRACTICE_WEIGHT)).toBe(true);

    // And the teacher's own view counts it, as a count and never as a score.
    const teacherView = await listForClass(world.organizationId, world.classId);
    const row = teacherView.find((item) => item.id === set.id)!;
    expect(row.done).toBe(1);
    expect(row.expected).toBeGreaterThanOrEqual(1);
    expect(Object.keys(row)).not.toContain("score");
    expect(Object.keys(row)).not.toContain("marks");
  });

  it("adopts a set the student already had open on that idea", async () => {
    const { world, conceptId } = await stocked();
    // Practising it of their own accord first, then being asked for it.
    const theirs = await startPractice(studentOf(world), {
      conceptId,
      questionCount: 4,
      source: "RECOMMENDED",
    });
    if (!theirs.ok) throw new Error(theirs.message);

    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      questionCount: 4,
    });
    if (!set.ok) throw new Error(set.message);

    const again = await startPractice(studentOf(world), {
      conceptId,
      questionCount: 4,
      source: "ASSIGNED",
      assignedPracticeId: set.id,
    });
    if (!again.ok) throw new Error(again.message);
    // The same set, now counting towards what was asked for. Two half-done
    // sets on one idea is what the resume rule exists to prevent.
    expect(again.sessionId).toBe(theirs.sessionId);

    const linked = await withTenant(world.organizationId, (tx) =>
      tx.practiceSession.findFirstOrThrow({ where: { id: theirs.sessionId } }),
    );
    expect(linked.assignedPracticeId).toBe(set.id);
  });
});

describe("withdrawing it", () => {
  it("stops it appearing, and is a stamp rather than a delete", async () => {
    const { world, conceptId } = await stocked();
    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      questionCount: 4,
    });
    if (!set.ok) throw new Error(set.message);

    expect(await cancelAssignedPractice(teacherOf(world), set.id)).toEqual({ ok: true });

    const mine = await openForStudent(world.organizationId, world.studentId);
    expect(mine.map((row) => row.id)).not.toContain(set.id);

    // The row survives, stamped: the sittings point at it, and "what was asked
    // for, and when was it withdrawn" is a question somebody asks.
    const row = await withTenant(world.organizationId, (tx) =>
      tx.assignedPractice.findFirstOrThrow({ where: { id: set.id } }),
    );
    expect(row.cancelledAt).not.toBeNull();

    // And withdrawing twice is not a second withdrawal.
    expect(await cancelAssignedPractice(teacherOf(world), set.id)).toEqual({ ok: false });
  });

  it("shows one organization nothing of another's instruction", async () => {
    const { world, conceptId } = await stocked();
    const other = await makeWorld();
    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      questionCount: 4,
    });
    if (!set.ok) throw new Error(set.message);

    expect(await cancelAssignedPractice(teacherOf(other), set.id)).toEqual({ ok: false });
    expect(await listForClass(other.organizationId, world.classId)).toEqual([]);
  });
});

describe("it is still practice", () => {
  it("records no marks anywhere on the instruction", async () => {
    const { world, conceptId } = await stocked();
    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      questionCount: 4,
      dueAt: new Date(Date.now() + 86_400_000),
    });
    if (!set.ok) throw new Error(set.message);

    const row = await withTenant(world.organizationId, (tx) =>
      tx.assignedPractice.findFirstOrThrow({ where: { id: set.id } }),
    );
    // Stated as a claim about the stored row rather than about the screens: a
    // column that exists is a column the next feature reads.
    const serialised = JSON.stringify(row).toLowerCase();
    for (const forbidden of ["marks", "score", "passmark", "grade"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("asks for no more than a set can be", async () => {
    const { world, conceptId } = await stocked(12);
    const set = await assignPractice(teacherOf(world), {
      classId: world.classId,
      conceptId,
      // Above MAX_SET. Clamped to what `startPractice` would actually serve,
      // so the card cannot promise twenty and hand over ten.
      questionCount: 50,
    });
    if (!set.ok) throw new Error(set.message);
    const row = await withTenant(world.organizationId, (tx) =>
      tx.assignedPractice.findFirstOrThrow({ where: { id: set.id } }),
    );
    expect(row.questionCount).toBe(10);
  });
});
