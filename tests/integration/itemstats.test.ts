import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import { createClass } from "@/core/classes";
import { addStudents } from "@/core/roster/add";
import { parseRoster } from "@/core/roster/parse";
import {
  approveQuestion,
  createQuestion,
  updateQuestion,
} from "@/core/questions";
import {
  createAssessment,
  publishAssessment,
  setQuestions,
} from "@/core/assessments";
import { createAssignment } from "@/core/assignments";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
} from "@/core/attempts";
import { questionItemStats, MIN_RESPONSES } from "@/core/itemstats";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Classical item statistics, end to end.
 *
 * Every fixture here is built fresh. The database is never reset between runs,
 * so nothing below hunts for a scarce shared row, nothing depends on a count
 * another suite could move, and no phone number is hard-coded — phone
 * uniqueness is global.
 *
 * The world is large on purpose: the threshold is thirty responses, so proving
 * the refusal AND proving the figures needs a real class of that size sitting a
 * real paper through the real player. A fixture of three students could only
 * ever exercise the refusal.
 */

/** 23 of 32 answer the MCQ correctly. The arithmetic is worked through below. */
const CORRECT = 23;
const SITTING = 32;
/** Three more, who sit a second paper that nobody has finished marking. */
const PENDING = 3;

type Actor = { organizationId: string; userId: string; role: string };

const world = {
  organizationId: "",
  teacher: {} as Actor,
  classId: "",
  studentIds: [] as string[],
  mcqId: "",
  tfId: "",
  saId: "",
  assignmentId: "",
  pendingAssignmentId: "",
};

/** Sits a paper through the real player and submits it. */
async function sit(
  studentId: string,
  assignmentId: string,
  choose: (question: { type: string }) => unknown,
) {
  const actor = { organizationId: world.organizationId, userId: studentId };
  const started = await startAttempt(actor, assignmentId, randomUUID());
  if (!started.ok) throw new Error(started.message);

  const player = await getPlayer(actor, started.attemptId);
  const patches = player!.questions.flatMap((question, index) => {
    const response = choose(question);
    return response === undefined
      ? []
      : [
          {
            assessmentQuestionId: question.assessmentQuestionId,
            response: response as never,
            clientSeq: index + 1,
          },
        ];
  });
  if (patches.length > 0) await saveAnswers(actor, started.attemptId, patches);
  await submitAttempt(actor, started.attemptId);
  return started.attemptId;
}

beforeAll(async () => {
  const signup = await signUp({
    fullName: "Teacher",
    email: `stats-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Item Stats Org",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!signup.ok) throw new Error(`signUp failed: ${signup.message}`);
  world.organizationId = signup.organizationId;

  const membership = await withTenant(signup.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );
  world.teacher = {
    organizationId: signup.organizationId,
    userId: membership.userId,
    role: signup.role,
  };

  const outcome = await prisma.learningOutcome.findFirstOrThrow({
    where: { code: "SIM-2" },
    include: { topic: { include: { chapter: { include: { subject: true } } } } },
  });
  const subjectId = outcome.topic.chapter.subjectId;
  const chapterId = outcome.topic.chapterId;

  const klass = await createClass(world.teacher, {
    name: "Class 10-A",
    gradeId: outcome.topic.chapter.subject.gradeId,
    subjectId,
    academicYear: "2026-27",
  });
  world.classId = klass.id;

  const names = Array.from(
    { length: SITTING + PENDING },
    // Letters only: a six-character hex slice that happened to be all digits
    // was read by the roster parser as a roll number, and a student went missing.
    (_, index) => `Student ${index} ${textToken().slice(0, 6)}`,
  ).join("\n");
  const roster = await addStudents(
    world.teacher,
    klass.id,
    parseRoster(names).students,
  );
  world.studentIds = roster.outcomes.flatMap((o) =>
    o.status === "added" ? [o.userId] : [],
  );
  expect(world.studentIds).toHaveLength(SITTING + PENDING);

  // Declared MEDIUM, and it stays MEDIUM whatever the answers say. Four
  // options, one of which nobody will ever choose.
  const mcq = await createQuestion(world.teacher, {
    type: "MCQ",
    subjectId,
    chapterId,
    difficulty: "MEDIUM",
    marks: 1,
    stem: `Which criterion needs two pairs of equal angles? ${textToken()}`,
    options: [
      { key: "A", text: "AA", isCorrect: true },
      { key: "B", text: "SSS", isCorrect: false },
      { key: "C", text: "SAS", isCorrect: false },
      { key: "D", text: "RHS", isCorrect: false },
    ],
    explanation: "Two equal angles force the third.",
    outcomeIds: [outcome.id],
  });
  if (!mcq.ok) throw new Error("mcq failed");
  await approveQuestion(world.teacher, mcq.id);
  world.mcqId = mcq.id;

  const tf = await createQuestion(world.teacher, {
    type: "TRUE_FALSE",
    subjectId,
    chapterId,
    difficulty: "EASY",
    marks: 1,
    stem: `Similar triangles always have equal areas. ${textToken()}`,
    answerKey: { kind: "boolean", correct: false },
    explanation: "Areas scale with the square of the side ratio.",
    outcomeIds: [outcome.id],
  });
  if (!tf.ok) throw new Error("tf failed");
  await approveQuestion(world.teacher, tf.id);
  world.tfId = tf.id;

  const sa = await createQuestion(world.teacher, {
    type: "SA",
    subjectId,
    chapterId,
    difficulty: "MEDIUM",
    marks: 3,
    stem: `Explain why AA is enough to prove similarity. ${textToken()}`,
    explanation: "The third angle follows.",
    outcomeIds: [outcome.id],
  });
  if (!sa.ok) throw new Error("sa failed");
  await approveQuestion(world.teacher, sa.id);
  world.saId = sa.id;

  world.assignmentId = await makePaper([world.mcqId, world.tfId], 2, 2);
  // The same MCQ on a second paper, alongside a written answer nobody will
  // mark. That is what makes "held back for marking" reachable at all.
  world.pendingAssignmentId = await makePaper([world.mcqId, world.saId], 4, 1);
});

async function makePaper(
  questionIds: string[],
  totalMarks: number,
  maxAttempts: number,
) {
  const assessment = await createAssessment(world.teacher, {
    title: `Paper ${randomUUID().slice(0, 6)}`,
    subjectId: (
      await withTenant(world.organizationId, (tx) =>
        tx.class.findFirstOrThrow({ where: { id: world.classId } }),
      )
    ).subjectId,
    gradeId: (
      await withTenant(world.organizationId, (tx) =>
        tx.class.findFirstOrThrow({ where: { id: world.classId } }),
      )
    ).gradeId,
    durationMinutes: 45,
    totalMarks,
  });
  if ("error" in assessment) throw new Error(assessment.error);

  await setQuestions(world.teacher, assessment.id, questionIds);
  const published = await publishAssessment(world.teacher, assessment.id);
  if (!published.ok) throw new Error(JSON.stringify(published.problems));

  const assignment = await createAssignment(world.teacher, {
    assessmentId: assessment.id,
    classId: world.classId,
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 24 * 3600_000),
    maxAttempts,
    resultsPolicy: "IMMEDIATE",
  });
  if (!assignment.ok) throw new Error(assignment.message);
  return assignment.id;
}

/**
 * Student `index` sits the main paper.
 *
 * The first 23 get the MCQ right and the true/false right; the last 9 get both
 * wrong, choosing B (five of them) and C (four). Nobody ever chooses D.
 */
const answerFor = (index: number) => (question: { type: string }) => {
  const right = index < CORRECT;
  if (question.type === "MCQ") {
    return {
      kind: "choice",
      keys: [right ? "A" : index < CORRECT + 5 ? "B" : "C"],
    };
  }
  // The true/false key is `false`, so a right answer is `false`.
  return { kind: "boolean", value: !right };
};

describe("classical item statistics", () => {
  it("refuses below the threshold, and says how far off it is", async () => {
    // Twenty of the thirty-two sit. Two thirds of a class is a real amount of
    // data and it is still not enough for a p-value anybody should act on.
    for (let index = 0; index < 20; index++) {
      await sit(world.studentIds[index]!, world.assignmentId, answerFor(index));
    }

    const data = await questionItemStats(world.organizationId, world.mcqId);
    expect(data).not.toBeNull();
    expect(data!.stats.enough).toBe(false);
    if (data!.stats.enough) throw new Error("unreachable");
    expect(data!.stats.responses).toBe(20);
    expect(data!.stats.needed).toBe(MIN_RESPONSES);
    expect(data!.stats.reason).toBe("too-few-responses");
    // No provisional figure anywhere on the payload for a component to reach
    // for. The refusal is a type, not a rule somebody has to remember.
    expect(JSON.stringify(data!.stats)).not.toContain("pValue");
  }, 120_000);

  it("computes the figures once the threshold is reached", async () => {
    for (let index = 20; index < SITTING; index++) {
      await sit(world.studentIds[index]!, world.assignmentId, answerFor(index));
    }

    const data = await questionItemStats(world.organizationId, world.mcqId);
    const stats = data!.stats;
    if (!stats.enough) throw new Error("expected figures");

    expect(stats.responses).toBe(SITTING);

    // 23 of 32 correct on a one-mark question: 23 / 32 = 0.71875 → 0.719.
    expect(stats.pValue).toBe(0.719);
    // 0.719 is at or above 0.7, so the answers read EASY.
    expect(stats.observedDifficulty).toBe("EASY");

    // Everybody who got the MCQ right also got the true/false right, so the
    // 23 score 1.0 on the paper and the 9 score 0. round(32 * 0.27) = 9, so
    // the top 9 are all correct and the bottom 9 are all wrong.
    expect(stats.groupSize).toBe(9);
    expect(stats.upperMean).toBe(1);
    expect(stats.lowerMean).toBe(0);
    expect(stats.discrimination).toBe(1);
    expect(stats.discriminationBand).toBe("EXCELLENT");

    // The rest of the paper is the single true/false, and it matches this item
    // for every student — so the correlation is exactly 1.
    expect(stats.pointBiserial).toBe(1);

    expect(stats.keySuspect).toBe(false);
  }, 120_000);

  it("counts every option, and names the one nobody ever chose", async () => {
    const data = await questionItemStats(world.organizationId, world.mcqId);
    const stats = data!.stats;
    if (!stats.enough) throw new Error("expected figures");

    const byKey = Object.fromEntries(
      (stats.options ?? []).map((option) => [option.key, option]),
    );
    expect(byKey.A!.chosen).toBe(23);
    expect(byKey.A!.isCorrect).toBe(true);
    expect(byKey.B!.chosen).toBe(5);
    expect(byKey.C!.chosen).toBe(4);
    // A distractor nobody picks is doing no work — the question offers three
    // real choices while looking like it offers four.
    expect(byKey.D!.chosen).toBe(0);
    expect(byKey.D!.dead).toBe(true);
    // Nobody beat the key, so no re-key suspicion.
    expect(byKey.B!.outperformsKey).toBe(false);

    // The strongest nine all chose the key; the weakest nine never did.
    expect(byKey.A!.upperChosen).toBe(9);
    expect(byKey.A!.lowerChosen).toBe(0);
    expect(byKey.B!.lowerChosen + byKey.C!.lowerChosen).toBe(9);
  }, 60_000);

  it("shows the observed difficulty BESIDE the declared one and never writes it back", async () => {
    const data = await questionItemStats(world.organizationId, world.mcqId);
    const stats = data!.stats;
    if (!stats.enough) throw new Error("expected figures");

    expect(stats.declaredDifficulty).toBe("MEDIUM");
    expect(stats.observedDifficulty).toBe("EASY");
    expect(stats.difficultyDisagrees).toBe(true);

    // The invariant this whole module is built around. `questions.difficulty`
    // is what `core/mastery` weights every piece of evidence with, so a figure
    // that silently rewrote it would move every gap, plan, intervention and
    // term report downstream of it — with no record of the teacher's own
    // judgement and no way to get it back.
    const row = await withTenant(world.organizationId, (tx) =>
      tx.question.findFirstOrThrow({ where: { id: world.mcqId } }),
    );
    expect(row.difficulty).toBe("MEDIUM");
  }, 60_000);

  it("holds back a paper with marking outstanding, and says how many", async () => {
    // Three students who have not sat the main paper sit a second one carrying
    // the same MCQ next to a written answer. Nobody marks the written answer,
    // so all three papers are held back whole.
    for (let index = SITTING; index < SITTING + PENDING; index++) {
      await sit(world.studentIds[index]!, world.pendingAssignmentId, (q) =>
        q.type === "MCQ"
          ? { kind: "choice", keys: ["A"] }
          : { kind: "text", value: "Because the third angle follows." },
      );
    }

    const data = await questionItemStats(world.organizationId, world.mcqId);
    const stats = data!.stats;
    if (!stats.enough) throw new Error("expected figures");

    expect(data!.awaitingMarking).toBe(PENDING);
    // Unchanged. Three more correct answers would have moved the p-value to
    // 26/35 = 0.743 — which would be a claim about a question nobody has
    // finished reading.
    expect(stats.responses).toBe(SITTING);
    expect(stats.pValue).toBe(0.719);
  }, 60_000);

  it("does not count a second sitting of the same paper", async () => {
    // The main paper allows two attempts. Student 31 got it wrong first time
    // and now knows the answer; the second meeting measures memory, not the
    // question.
    await sit(world.studentIds[31]!, world.assignmentId, (q) =>
      q.type === "MCQ"
        ? { kind: "choice", keys: ["A"] }
        : { kind: "boolean", value: false },
    );

    const data = await questionItemStats(world.organizationId, world.mcqId);
    const stats = data!.stats;
    if (!stats.enough) throw new Error("expected figures");

    expect(data!.repeatSittings).toBe(1);
    expect(stats.responses).toBe(SITTING);
    expect(stats.pValue).toBe(0.719);
  }, 60_000);

  it("never crosses a tenant boundary", async () => {
    const other = await signUp({
      fullName: "Other Teacher",
      email: `stats-other-${randomUUID()}@example.test`,
      password: "a-long-enough-password",
      organizationName: "Other Org",
      organizationType: "TUITION_CENTRE",
      boardCode: "CBSE",
    });
    if (!other.ok) throw new Error("signUp failed");

    // Not an empty statistic — nothing at all. Two centres may legitimately
    // hold the same question and neither learns about the other's bank.
    expect(
      await questionItemStats(other.organizationId, world.mcqId),
    ).toBeNull();
  }, 60_000);

  it("attaches the figures to the VERSION, so an edit starts again", async () => {
    // Deliberately last: it destroys the statistics above. Editing an approved
    // question creates version n+1, and thirty-two answers to the old wording
    // describe a question that no longer exists.
    const edited = await updateQuestion(world.teacher, world.mcqId, {
      type: "MCQ",
      subjectId: (
        await withTenant(world.organizationId, (tx) =>
          tx.question.findFirstOrThrow({ where: { id: world.mcqId } }),
        )
      ).subjectId,
      chapterId: (
        await withTenant(world.organizationId, (tx) =>
          tx.question.findFirstOrThrow({ where: { id: world.mcqId } }),
        )
      ).chapterId,
      difficulty: "MEDIUM",
      marks: 1,
      stem: `Which similarity criterion needs two pairs of equal angles? ${textToken()}`,
      options: [
        { key: "A", text: "AA", isCorrect: true },
        { key: "B", text: "SSS", isCorrect: false },
        { key: "C", text: "SAS", isCorrect: false },
        { key: "D", text: "RHS", isCorrect: false },
      ],
      explanation: "Two equal angles force the third.",
      outcomeIds: [
        (
          await withTenant(world.organizationId, (tx) =>
            tx.questionOutcome.findFirstOrThrow({
              where: { questionId: world.mcqId },
            }),
          )
        ).learningOutcomeId,
      ],
    });
    expect(edited.ok).toBe(true);

    const data = await questionItemStats(world.organizationId, world.mcqId);
    expect(data!.version).toBe(2);
    expect(data!.versionCount).toBe(2);
    expect(data!.stats.enough).toBe(false);
    if (data!.stats.enough) throw new Error("unreachable");
    expect(data!.stats.responses).toBe(0);
    expect(data!.stats.reason).toBe("no-responses");
    // Counted and reported, so "it used to have statistics" has an answer.
    // 32 first sittings + 1 re-sitting + 3 held back for marking.
    expect(data!.earlierVersionResponses).toBe(SITTING + 1 + PENDING);
  }, 60_000);
});
