import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { approveQuestion, createQuestion } from "@/core/questions";
import {
  answerPractice,
  getPractice,
  recentSessions,
  recommendations,
  startPractice,
} from "@/core/practice";
import {
  PRACTICE_WEIGHT,
  recordPracticeEvidence,
} from "@/core/practice/evidence";
import { listMistakes } from "@/core/mistakes/read";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import type { Response } from "@/core/attempts/score";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

/** Stock the bank with approved MCQs on the world's outcome. */
async function stock(world: World, count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const question = await createQuestion(teacherOf(world), {
      type: "MCQ",
      subjectId: world.subjectId,
      chapterId: world.chapterId,
      difficulty: (["EASY", "MEDIUM", "HARD"] as const)[index % 3]!,
      marks: 1,
      stem: `Practice question ${index} — ${textToken()}`,
      options: [
        { key: "A", text: "The right one", isCorrect: true },
        { key: "B", text: "The wrong one", isCorrect: false },
      ],
      explanation: `Because of the reason for question ${index}.`,
      outcomeIds: [world.outcomeId],
    });
    if (!question.ok) throw new Error("stocking failed");
    await approveQuestion(teacherOf(world), question.id);
    ids.push(question.id);
  }
  return ids;
}

/** Sit the world's paper, right or wrong, to produce assessment evidence. */
async function sit(world: World, correct: boolean) {
  const actor = studentOf(world);
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
  await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);
}

/** A student with a measured, weak concept and a stocked bank. */
async function struggling(questions = 10) {
  const world = await makeWorld({ maxAttempts: 5 });
  await stock(world, questions);
  for (let pass = 0; pass < 3; pass++) await sit(world, false);
  return world;
}

/**
 * Work through a whole set, answering correctly or not.
 *
 * Branches on the question TYPE. A helper that sent a choice response to every
 * question would mark the true/false wrong whatever it meant to do, and then
 * report a set answered perfectly as 75%.
 */
async function workThrough(world: World, sessionId: string, correct: boolean) {
  const actor = studentOf(world);

  // Loops rather than iterating a fixed list: questions are served ONE AT A
  // TIME, each chosen from how the set has gone so far, so the next one does
  // not exist until the current one is answered. Bounded, so a bug that never
  // finishes fails the test rather than hanging it.
  for (let guard = 0; guard < 30; guard++) {
    const view = await getPractice(actor, sessionId);
    const open = view!.questions.find((question) => question.isCorrect === null);
    if (!open) return;

    const response: Response =
      open.type === "TRUE_FALSE"
        ? // The world's true/false is keyed `false`.
          { kind: "boolean", value: !correct }
        : { kind: "choice", keys: [correct ? "A" : "B"] };
    const result = await answerPractice(actor, open.practiceAnswerId, response);
    if (!result.ok || result.finished) return;
  }
  throw new Error("workThrough did not finish");
}

describe("what to practise", () => {
  it("refuses to suggest anything before anything is measured", async () => {
    const world = await makeWorld();
    await stock(world, 8);

    const result = await recommendations(studentOf(world));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("nothing-measured");
      expect(result.message).toMatch(/sit a test/i);
    }
  });

  it("names the weak concept, with the number in the sentence", async () => {
    const world = await struggling();

    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);

    expect(result.candidates.length).toBeGreaterThan(0);
    const first = result.candidates[0]!;
    expect(first.conceptName).toBeTruthy();
    // A student sent to another page to find out what to practise does not go.
    expect(first.rationale).toContain(first.conceptName);
  });

  it("does not offer a concept the bank cannot fill a set from", async () => {
    // Measured and weak, but only two questions exist beyond the paper itself.
    const world = await makeWorld({ maxAttempts: 5 });
    for (let pass = 0; pass < 3; pass++) await sit(world, false);

    const result = await recommendations(studentOf(world));
    // The world ships two questions, both used by the paper — not a set.
    if (result.ok) {
      expect(
        result.candidates.every((candidate) => candidate.questionCount >= 4),
      ).toBe(true);
    } else {
      expect(result.reason).toBe("bank-too-thin");
    }
  });
});

describe("running a set", () => {
  it("serves approved, machine-markable questions only", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);

    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    const view = await getPractice(studentOf(world), started.sessionId);
    // One question is served at a time; the COUNT is what the set aims for.
    expect(view!.questions).toHaveLength(1);
    expect(view!.questionCount).toBeGreaterThanOrEqual(4);
    // Nothing that needs a person: there is nobody waiting to mark it.
    expect(view!.questions.every((q) => q.type === "MCQ" || q.type === "TRUE_FALSE")).toBe(
      true,
    );
    // And no answers on the wire before they have answered.
    expect(view!.questions.every((q) => q.explanation === null)).toBe(true);
    expect(JSON.stringify(view!.questions)).not.toMatch(/isCorrect":\s*true/);
  });

  it("tells them at once, and only about the question they answered", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    // Work forward to whichever MCQ gets served. Which question comes first is
    // chosen from the student's own level, so the test does not assume one.
    let view = await getPractice(studentOf(world), started.sessionId);
    let open = view!.questions[0]!;
    for (let guard = 0; guard < 10 && open.type === "TRUE_FALSE"; guard++) {
      const skipped = await answerPractice(studentOf(world), open.practiceAnswerId, {
        kind: "boolean",
        value: true,
      });
      if (!skipped.ok || skipped.finished) throw new Error("no MCQ was served");
      view = await getPractice(studentOf(world), started.sessionId);
      open = view!.questions.find((q) => q.isCorrect === null)!;
    }

    const answered = await answerPractice(studentOf(world), open.practiceAnswerId, {
      kind: "choice",
      keys: ["B"],
    });
    if (!answered.ok) throw new Error(answered.message);

    // Immediately — this is the whole difference from a test.
    expect(answered.correct).toBe(false);
    expect(answered.explanation).toBeTruthy();
    expect(answered.correctAnswer).toContain("The right one");

    // The one they answered is unsealed; nothing else is.
    const after = await getPractice(studentOf(world), started.sessionId);
    const reopened = after!.questions.find(
      (q) => q.practiceAnswerId === open.practiceAnswerId,
    )!;
    expect(reopened.explanation).toBeTruthy();
    // Every UNANSWERED question is sealed. Filtering on the one just answered
    // is not enough — anything answered on the way here is legitimately
    // unsealed too, and the rule is about what they have not done yet.
    expect(
      after!.questions
        .filter((q) => q.isCorrect === null)
        .every((q) => q.explanation === null && q.correctAnswer === null),
    ).toBe(true);
    // And the next one arrived with the verdict, sealed — so the runner needs
    // no second round trip between questions.
    expect(answered.next).not.toBeNull();
    expect(answered.next?.explanation ?? null).toBeNull();
  });

  it("refuses a second answer to the same question", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    const view = await getPractice(studentOf(world), started.sessionId);
    const first = view!.questions[0]!;
    await answerPractice(studentOf(world), first.practiceAnswerId, {
      kind: "choice",
      keys: ["B"],
    });
    const again = await answerPractice(studentOf(world), first.practiceAnswerId, {
      kind: "choice",
      keys: ["A"],
    });
    // A set a student could walk until every verdict was green would make
    // practice evidence worthless.
    expect(again.ok).toBe(false);
  });

  it("resumes an unfinished set rather than starting a second", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const conceptId = result.candidates[0]!.conceptId;

    const first = await startPractice(studentOf(world), { conceptId, source: "RECOMMENDED" });
    const second = await startPractice(studentOf(world), { conceptId, source: "RECOMMENDED" });
    if (!first.ok || !second.ok) throw new Error("start failed");
    // On a phone, backgrounding and re-tapping happens constantly.
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("scores the session when the last question is answered", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    await workThrough(world, started.sessionId, true);

    const view = await getPractice(studentOf(world), started.sessionId);
    expect(view!.completedAt).not.toBeNull();
    expect(view!.score).toBe(1);

    const [recent] = await recentSessions(studentOf(world));
    expect(recent!.completedAt).not.toBeNull();
  });
});

describe("practice is evidence, at a reduced weight", () => {
  it("writes evidence stamped PRACTICE, weighted down", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    await workThrough(world, started.sessionId, true);

    const evidence = await withTenant(world.organizationId, (tx) =>
      tx.conceptEvidence.findMany({
        where: { studentUserId: world.studentId, source: "PRACTICE" },
      }),
    );
    expect(evidence.length).toBeGreaterThan(0);
    // Weighted down. At full weight, mastery becomes a function of persistence
    // and a student could close their own gap by grinding at home.
    expect(evidence.every((row) => Number(row.weight) <= PRACTICE_WEIGHT)).toBe(true);
    // And stamped, which is what makes 0.4 a reversible decision: rebuildMastery
    // can re-derive every estimate if the number turns out wrong.
    expect(evidence.every((row) => row.source === "PRACTICE")).toBe(true);
    expect(evidence.every((row) => row.attemptAnswerId === null)).toBe(true);
  });

  it("leaves assessment evidence at full weight", async () => {
    const world = await struggling();
    const assessment = await withTenant(world.organizationId, (tx) =>
      tx.conceptEvidence.findMany({
        where: { studentUserId: world.studentId, source: "ASSESSMENT" },
      }),
    );
    expect(assessment.length).toBeGreaterThan(0);
    expect(assessment.some((row) => Number(row.weight) > PRACTICE_WEIGHT)).toBe(true);
  });

  it("moves the estimate, but less than the same number of exam questions", async () => {
    const world = await struggling();
    const before = await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.findFirst({ where: { studentUserId: world.studentId } }),
    );

    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    await workThrough(world, started.sessionId, true);

    const after = await withTenant(world.organizationId, (tx) =>
      tx.studentConceptMastery.findFirst({
        where: { studentUserId: world.studentId, conceptId: before!.conceptId },
      }),
    );
    // It counts — otherwise a PRACTICE_SET intervention could never be measured
    // as having worked, which is the product's own North Star.
    expect(Number(after!.estimate)).toBeGreaterThan(Number(before!.estimate));
    // But it does not carry them over the line in one sitting.
    expect(Number(after!.estimate)).toBeLessThan(0.6);
  });

  it("credits nothing for a set left half done", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    const view = await getPractice(studentOf(world), started.sessionId);
    const first = view!.questions[0]!;
    await answerPractice(
      studentOf(world),
      first.practiceAnswerId,
      first.type === "TRUE_FALSE"
        ? { kind: "boolean", value: false }
        : { kind: "choice", keys: ["A"] },
    );

    const evidence = await withTenant(world.organizationId, (tx) =>
      tx.conceptEvidence.count({
        where: { studentUserId: world.studentId, source: "PRACTICE" },
      }),
    );
    // Crediting the ones answered before the tab closed would reward starting
    // over finishing.
    expect(evidence).toBe(0);
  });

  it("closes a mistake the student fixes by practising", async () => {
    const world = await struggling();
    const open = await listMistakes(world.organizationId, world.studentId);
    expect(open.length).toBeGreaterThan(0);

    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    await workThrough(world, started.sessionId, true);

    // Deliberate. A student cannot set themselves a paper, so a bank only a
    // test can clear is a list that only grows.
    const after = await listMistakes(world.organizationId, world.studentId, {
      includeResolved: true,
    });
    expect(after.some((mistake) => mistake.status === "RESOLVED")).toBe(true);
  });
});

describe("help costs the answer its evidence", () => {
  it("writes nothing for a question the tutor was asked about first", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    // Ask for help on the first question BEFORE answering it. Written straight
    // into the table rather than through askForHelp: what is under test is the
    // evidence rule, and routing it through a mocked provider would make this
    // a test of the mock.
    const opening = await getPractice(studentOf(world), started.sessionId);
    const firstOpen = opening!.questions.find((q) => q.isCorrect === null)!;
    await withTenant(world.organizationId, (tx) =>
      tx.tutorSession.createMany({
        data: [
          {
            id: randomUUID(),
            organizationId: world.organizationId,
            studentUserId: world.studentId,
            questionId: firstOpen.questionId,
            practiceAnswerId: firstOpen.practiceAnswerId,
            maxLevel: "STEPS",
            createdAt: new Date(Date.now() - 60_000),
          },
        ],
      }),
    );

    await workThrough(world, started.sessionId, true);

    const answers = await withTenant(world.organizationId, (tx) =>
      tx.practiceAnswer.findMany({
        where: { practiceSessionId: started.sessionId },
        select: { id: true, questionId: true },
      }),
    );
    const helpedAnswerIds = answers
      .filter((answer) => answer.questionId === firstOpen.questionId)
      .map((answer) => answer.id);

    const evidence = await withTenant(world.organizationId, (tx) =>
      tx.conceptEvidence.findMany({
        where: { studentUserId: world.studentId, source: "PRACTICE" },
        select: { practiceAnswerId: true },
      }),
    );

    // Nothing at all for the helped one — not a reduced weight. A number that
    // is a little bit wrong is harder to notice than one that is absent, and
    // this one ends up in front of a teacher deciding whether to reteach.
    for (const helpedId of helpedAnswerIds) {
      expect(evidence.some((row) => row.practiceAnswerId === helpedId)).toBe(false);
    }
    // And the rest of the set still counts. Taking help is not a penalty on
    // the whole session.
    expect(evidence.length).toBeGreaterThan(0);
  });

  it("still counts an answer they asked about AFTERWARDS", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    const opening = await getPractice(studentOf(world), started.sessionId);
    const firstOpen = opening!.questions.find((q) => q.isCorrect === null)!;

    await workThrough(world, started.sessionId, true);

    // Asked from the review screen, after the answer was already given
    // unaided. That cannot retrospectively void work they had already done.
    await withTenant(world.organizationId, (tx) =>
      tx.tutorSession.createMany({
        data: [
          {
            id: randomUUID(),
            organizationId: world.organizationId,
            studentUserId: world.studentId,
            questionId: firstOpen.questionId,
            maxLevel: "HINT",
            createdAt: new Date(Date.now() + 60_000),
          },
        ],
      }),
    );

    const report = await recordPracticeEvidence(world.organizationId, started.sessionId);
    expect(report.skippedAsHelped).toBe(0);
  });
});

describe("a question just answered correctly is not served again", () => {
  it("keeps the cooldown across sessions", async () => {
    const world = await struggling(12);
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const conceptId = result.candidates[0]!.conceptId;

    const first = await startPractice(studentOf(world), { conceptId, source: "RECOMMENDED" });
    if (!first.ok) throw new Error(first.message);
    await workThrough(world, first.sessionId, true);
    // Read AFTER working through: the set is served one at a time, so the full
    // list only exists once it is finished.
    const firstView = await getPractice(studentOf(world), first.sessionId);

    const second = await startPractice(studentOf(world), { conceptId, source: "RECOMMENDED" });
    if (!second.ok) throw new Error(second.message);
    const secondView = await getPractice(studentOf(world), second.sessionId);

    const firstStems = new Set(firstView!.questions.map((q) => q.stem));
    // Repeating what you can already do is the least useful minute in revision
    // — and it is what would let a student grind four questions until the
    // estimate said whatever they wanted.
    expect(secondView!.questions.every((q) => !firstStems.has(q.stem))).toBe(true);
  });

  it("serves a question they got WRONG again", async () => {
    const world = await struggling(12);
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const conceptId = result.candidates[0]!.conceptId;

    const first = await startPractice(studentOf(world), { conceptId, source: "RECOMMENDED" });
    if (!first.ok) throw new Error(first.message);
    await workThrough(world, first.sessionId, false);
    const firstView = await getPractice(studentOf(world), first.sessionId);

    const second = await startPractice(studentOf(world), { conceptId, source: "RECOMMENDED" });
    if (!second.ok) throw new Error(second.message);
    const secondView = await getPractice(studentOf(world), second.sessionId);

    const firstStems = new Set(firstView!.questions.map((q) => q.stem));
    // The cooldown is for things they can do, not things they cannot.
    expect(secondView!.questions.some((q) => firstStems.has(q.stem))).toBe(true);
  });
});

describe("tenancy and scope", () => {
  it("shows one student nothing of another's session", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    const other = {
      organizationId: world.organizationId,
      userId: world.otherStudentId,
    };
    expect(await getPractice(other, started.sessionId)).toBeNull();

    const view = await getPractice(studentOf(world), started.sessionId);
    const stolen = await answerPractice(other, view!.questions[0]!.practiceAnswerId, {
      kind: "choice",
      keys: ["A"],
    });
    expect(stolen.ok).toBe(false);
  });

  it("shows another organisation nothing", async () => {
    const world = await struggling();
    const result = await recommendations(studentOf(world));
    if (!result.ok) throw new Error(result.message);
    const started = await startPractice(studentOf(world), {
      conceptId: result.candidates[0]!.conceptId,
      source: "RECOMMENDED",
    });
    if (!started.ok) throw new Error(started.message);

    const stranger = await makeWorld();
    expect(
      await getPractice(
        { organizationId: stranger.organizationId, userId: world.studentId },
        started.sessionId,
      ),
    ).toBeNull();

    const reachable = await withTenant(stranger.organizationId, (tx) =>
      tx.practiceSession.findMany({ where: { studentUserId: world.studentId } }),
    );
    expect(reachable).toHaveLength(0);
  });
});
