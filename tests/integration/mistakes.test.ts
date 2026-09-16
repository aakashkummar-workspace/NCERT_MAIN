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
import {
  getMistake,
  listMistakes,
  mistakeSummary,
  reconcileResolved,
  retryMistake,
} from "@/core/mistakes/read";
import { rebuildMistakes } from "@/core/mistakes/record";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

const student = (world: World) => studentOf(world);

/**
 * Sit the world's paper. `mcq` and `tf` say what to put; `undefined` leaves the
 * question blank, which is a different fact about the student from wrong.
 */
async function sit(
  world: World,
  actor: { organizationId: string; userId: string },
  choices: { mcq?: string; tf?: boolean; written?: string },
) {
  const started = await startAttempt(actor, world.assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);

  const player = await getPlayer(actor, started.attemptId);
  const patches: AnswerPatch[] = [];
  for (const [index, question] of player!.questions.entries()) {
    if (question.type === "MCQ" && choices.mcq !== undefined) {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "choice", keys: [choices.mcq] },
        clientSeq: index + 1,
      });
    } else if (question.type === "TRUE_FALSE" && choices.tf !== undefined) {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "boolean", value: choices.tf },
        clientSeq: index + 1,
      });
    } else if (question.type === "SA" && choices.written !== undefined) {
      patches.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "text", value: choices.written },
        clientSeq: index + 1,
      });
    }
  }
  if (patches.length > 0) await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);
  return started.attemptId;
}

describe("a mistake is a settled wrong answer", () => {
  it("records the objective ones the moment the paper is submitted", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    // B is wrong on the MCQ; true is wrong on the true/false.
    await sit(world, student(world), { mcq: "B", tf: true });

    const mistakes = await listMistakes(world.organizationId, world.studentId);
    expect(mistakes).toHaveLength(2);
    expect(mistakes.every((m) => m.status === "UNRESOLVED")).toBe(true);
    // The stem travels with it. A bank listing "Question 3" is a bank nobody
    // opens.
    expect(mistakes.every((m) => m.stem.length > 10)).toBe(true);
  });

  it("records nothing for the questions they got right", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "A", tf: false });

    expect(await listMistakes(world.organizationId, world.studentId)).toHaveLength(0);
  });

  it("types a blank as unattempted, not as wrong", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    // The MCQ answered wrongly, the true/false left alone.
    await sit(world, student(world), { mcq: "B" });

    const mistakes = await listMistakes(world.organizationId, world.studentId);
    const blank = mistakes.find((m) => m.mistakeType === "UNATTEMPTED");
    expect(blank).toBeDefined();
    // Free to type, and certain. Nothing here should be waiting on a model.
    expect(blank!.classified).toBe(true);
    expect(blank!.typeReason).toMatch(/blank/i);
  });

  it("will not put an unmarked written answer in a student's bank", async () => {
    // The worst thing this feature could do: show somebody their own three
    // paragraphs under "you got this wrong" before anybody has read them.
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sit(world, student(world), {
      mcq: "A",
      tf: false,
      written: "Because the third angle follows from the first two.",
    });

    const mistakes = await listMistakes(world.organizationId, world.studentId);
    expect(mistakes).toHaveLength(0);
  });

  it("records it the moment a person marks it short", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sit(world, student(world), {
      mcq: "A",
      tf: false,
      written: "Something not quite right.",
    });

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const item = queue!.groups[0]!.answers[0]!;
    await awardMarks(teacherOf(world), item.answerId, 1);

    const mistakes = await listMistakes(world.organizationId, world.studentId);
    expect(mistakes).toHaveLength(1);
    // The marks travel with it, so "1 of 3" is on the card rather than a bare
    // "wrong" for an answer that was most of the way there.
    expect(mistakes[0]!.awarded).toBe(1);
    expect(mistakes[0]!.marks).toBe(3);
  });

  it("clears it again when the teacher raises it to full marks", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sit(world, student(world), {
      mcq: "A",
      tf: false,
      written: "A good answer, marked in haste.",
    });

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    const item = queue!.groups[0]!.answers[0]!;
    await awardMarks(teacherOf(world), item.answerId, 1);
    expect(await listMistakes(world.organizationId, world.studentId)).toHaveLength(1);

    // The teacher looks again. The bank must not argue with them.
    await awardMarks(teacherOf(world), item.answerId, 3);
    expect(await listMistakes(world.organizationId, world.studentId)).toHaveLength(0);
  });

  it("does not deal the same card twice", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B", tf: true });

    const before = await listMistakes(world.organizationId, world.studentId);
    // Re-derived from answers that never moved — the same property the mastery
    // ledger has, and the reason a failed write is recoverable.
    await rebuildMistakes(world.organizationId, world.studentId);
    const after = await listMistakes(world.organizationId, world.studentId);

    expect(after).toHaveLength(before.length);
    expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
  });
});

describe("the answer is withheld until they have had a go", () => {
  it("hides the explanation and the key on first open", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B", tf: true });

    const [first] = await listMistakes(world.organizationId, world.studentId);
    const detail = await getMistake(
      world.organizationId,
      world.studentId,
      first!.id,
    );
    expect(detail!.revealed).toBe(false);
    expect(detail!.explanation).toBeNull();
    expect(detail!.correctAnswer).toBeNull();
  });

  it("never ships isCorrect on the options, revealed or not", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B" });

    const mistakes = await listMistakes(world.organizationId, world.studentId);
    const mcq = mistakes.find((m) => m.marks === 2)!;
    const detail = await getMistake(world.organizationId, world.studentId, mcq.id);
    // Rebuilt field by field rather than filtered, so a field added to Option
    // later cannot leak by being forgotten.
    expect(JSON.stringify(detail!.options)).not.toMatch(/isCorrect/);
  });

  it("reveals it once they have retried, right or wrong", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B" });

    const mistakes = await listMistakes(world.organizationId, world.studentId);
    const mcq = mistakes.find((m) => m.marks === 2)!;

    await retryMistake(
      { organizationId: world.organizationId, userId: world.studentId },
      mcq.id,
      { kind: "choice", keys: ["C"] },
    );

    const detail = await getMistake(world.organizationId, world.studentId, mcq.id);
    expect(detail!.revealed).toBe(true);
    expect(detail!.explanation).toBeTruthy();
    expect(detail!.correctAnswer).toContain("AA");
  });
});

describe("retrying is engagement, not proof", () => {
  it("moves a correct retry to RETRIED and not to RESOLVED", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B" });

    const mistakes = await listMistakes(world.organizationId, world.studentId);
    const mcq = mistakes.find((m) => m.marks === 2)!;

    const result = await retryMistake(
      { organizationId: world.organizationId, userId: world.studentId },
      mcq.id,
      { kind: "choice", keys: ["A"] },
    );
    if (!result.ok) throw new Error(result.message);

    expect(result.correct).toBe(true);
    // The whole point. Re-answering a question you have seen the answer to
    // mostly measures memory, and a bank a student can clear in an evening
    // without learning anything is the failure mode this avoids.
    expect(result.status).toBe("RETRIED");
    expect(result.message).toMatch(/different question/i);
  });

  it("leaves a wrong retry unresolved and counts it", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B" });

    const mistakes = await listMistakes(world.organizationId, world.studentId);
    const mcq = mistakes.find((m) => m.marks === 2)!;

    const result = await retryMistake(
      { organizationId: world.organizationId, userId: world.studentId },
      mcq.id,
      { kind: "choice", keys: ["C"] },
    );
    if (!result.ok) throw new Error(result.message);

    expect(result.correct).toBe(false);
    expect(result.status).toBe("UNRESOLVED");
    expect(result.retryCount).toBe(1);
    // Not "try again" — a second guess now teaches nothing.
    expect(result.message).toMatch(/explanation/i);
  });

  it("refuses to retry something only a person can mark", async () => {
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sit(world, student(world), {
      mcq: "A",
      tf: false,
      written: "Not quite.",
    });
    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    await awardMarks(teacherOf(world), queue!.groups[0]!.answers[0]!.answerId, 0);

    const [written] = await listMistakes(world.organizationId, world.studentId);
    const result = await retryMistake(
      { organizationId: world.organizationId, userId: world.studentId },
      written!.id,
      { kind: "text", value: "Another go." },
    );
    // Told plainly, rather than accepted and silently never marked.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/a person/i);
  });
});

describe("a mistake closes on independent evidence", () => {
  it("resolves when a different question on the concept goes right", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B", tf: true });
    expect(
      (await listMistakes(world.organizationId, world.studentId)).every(
        (m) => m.status === "UNRESOLVED",
      ),
    ).toBe(true);

    // They sit it again and get everything right. Both questions map to the
    // same concept, so each is independent proof about the other.
    await sit(world, student(world), { mcq: "A", tf: false });

    const after = await listMistakes(world.organizationId, world.studentId, {
      includeResolved: true,
    });
    expect(after.every((m) => m.status === "RESOLVED")).toBe(true);
    expect(after.every((m) => m.resolvedAt !== null)).toBe(true);
  });

  it("does not resolve on a partly right answer", async () => {
    // The same refusal the marking layer makes. 2 out of 3 is progress, not
    // proof, and closing on it would quietly redefine what the bank claims.
    const world = await makeWorld({ maxAttempts: 3, withWritten: true });
    await sit(world, student(world), { mcq: "B", tf: true, written: "Partly." });

    const queue = await markingQueue(teacherOf(world), world.assignmentId);
    await awardMarks(teacherOf(world), queue!.groups[0]!.answers[0]!.answerId, 2);

    const after = await listMistakes(world.organizationId, world.studentId, {
      includeResolved: true,
    });
    expect(after.some((m) => m.status === "RESOLVED")).toBe(false);
  });

  it("is a reconciliation — running it again changes nothing", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B", tf: true });
    await sit(world, student(world), { mcq: "A", tf: false });

    const before = await listMistakes(world.organizationId, world.studentId, {
      includeResolved: true,
    });
    await reconcileResolved(world.organizationId, world.studentId);
    const after = await listMistakes(world.organizationId, world.studentId, {
      includeResolved: true,
    });

    expect(after).toHaveLength(before.length);
    for (const [index, row] of after.entries()) {
      // The date it closed does not move on a second pass, so "how long has
      // this been fixed" keeps its answer.
      expect(row.resolvedAt?.getTime()).toBe(before[index]!.resolvedAt?.getTime());
    }
  });

});

describe("the summary on home", () => {
  it("counts by state and names the worst concept", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B", tf: true });

    const summary = await mistakeSummary(world.organizationId, world.studentId);
    expect(summary.open).toBe(2);
    expect(summary.retried).toBe(0);
    expect(summary.resolved).toBe(0);
    // By name. "You have two to work on" sends them to another page to find
    // out with what.
    expect(summary.worst?.conceptName).toBeTruthy();
    expect(summary.worst?.count).toBe(2);
  });
});

describe("tenancy and scope", () => {
  it("shows another organisation nothing", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B", tf: true });

    const other = await makeWorld();
    expect(
      await listMistakes(other.organizationId, world.studentId),
    ).toHaveLength(0);
  });

  it("shows one student nothing of another's", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B", tf: true });

    // Same organisation, same class, different person.
    expect(
      await listMistakes(world.organizationId, world.otherStudentId),
    ).toHaveLength(0);
  });

  it("refuses to fetch a mistake belonging to somebody else", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B" });
    const [mine] = await listMistakes(world.organizationId, world.studentId);

    const stolen = await getMistake(
      world.organizationId,
      world.otherStudentId,
      mine!.id,
    );
    expect(stolen).toBeNull();

    const retried = await retryMistake(
      { organizationId: world.organizationId, userId: world.otherStudentId },
      mine!.id,
      { kind: "choice", keys: ["A"] },
    );
    expect(retried.ok).toBe(false);
  });

  it("keeps the row behind row-level security", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, student(world), { mcq: "B" });
    const other = await makeWorld();

    const reachable = await withTenant(other.organizationId, (tx) =>
      tx.studentMistake.findMany({ where: { studentUserId: world.studentId } }),
    );
    expect(reachable).toHaveLength(0);
  });
});
