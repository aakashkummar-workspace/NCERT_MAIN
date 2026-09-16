import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import { generateIntoBank } from "@/core/questions/generate";
import { setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import { buildSystem, REJECTING } from "@/ai/tasks/validate-questions";
import type { GeneratedQuestion } from "@/ai/tasks/generate-questions";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

let mock: MockProvider;

beforeEach(() => {
  mock = new MockProvider();
  setProvider(mock);
});

afterEach(() => {
  setProvider(null);
});

async function makeOrg() {
  const result = await signUp({
    fullName: "Validating Teacher",
    email: `val-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Validating Org",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!result.ok) throw new Error("signUp failed");

  const membership = await withTenant(result.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );
  return {
    organizationId: result.organizationId,
    userId: membership.userId,
    role: result.role,
  };
}

async function authoredChapter() {
  const outcome = await prisma.learningOutcome.findFirstOrThrow({
    where: { code: "SIM-2" },
    include: { topic: true },
  });
  return outcome.topic.chapterId;
}

function good(overrides: Partial<GeneratedQuestion> = {}): GeneratedQuestion {
  return {
    type: "MCQ",
    difficulty: "MEDIUM",
    marks: 1,
    stem: `Which criterion proves two triangles similar from two angles? ${textToken()}`,
    options: [
      { key: "A", text: "The AA criterion", isCorrect: true },
      { key: "B", text: "The SSS congruence criterion", isCorrect: false },
      { key: "C", text: "The RHS criterion", isCorrect: false },
    ],
    answerValue: null,
    answerBoolean: null,
    acceptedAnswers: null,
    explanation: "Two equal angles force the third, so the triangles are equiangular.",
    ...overrides,
  };
}

const ask = { count: 2, types: ["MCQ" as const], difficulty: "MEDIUM" as const, marks: 1 };

/** Generation succeeds, then validation returns whatever the test scripts. */
function scriptRun(questions: GeneratedQuestion[], verdicts: unknown) {
  mock.script(
    { kind: "ok", value: { questions } },
    { kind: "ok", value: verdicts },
  );
}

describe("the reading gate", () => {
  it("runs on the drafts the deterministic gate passed", async () => {
    const org = await makeOrg();
    scriptRun([good(), good()], { verdicts: [] });

    await generateIntoBank(org, { chapterId: await authoredChapter(), ...ask });

    // Two calls: generate, then validate.
    expect(mock.callCount).toBe(2);
    const review = mock.received[1]!;
    expect(review.tier).toBe("FAST");
    expect(review.messages[0]!.content).toContain("Review these 2 drafts");
  });

  it("does not pay a model to read what a rule already rejected", async () => {
    const org = await makeOrg();
    scriptRun(
      [
        good(),
        // No correct option: an error the deterministic validator catches.
        good({
          options: [
            { key: "A", text: "The AA criterion", isCorrect: false },
            { key: "B", text: "The SSS criterion", isCorrect: false },
          ],
        }),
      ],
      { verdicts: [] },
    );

    await generateIntoBank(org, { chapterId: await authoredChapter(), ...ask });
    expect(mock.received[1]!.messages[0]!.content).toContain("Review these 1 drafts");
  });

  it("drops a question with the answer in the stem before anybody sees it", async () => {
    const org = await makeOrg();
    scriptRun([good(), good()], {
      verdicts: [
        {
          index: 1,
          reject: true,
          reasons: [
            {
              code: "answer-in-stem",
              note: "The stem names the AA criterion, so the question asks nothing.",
            },
          ],
        },
      ],
    });

    const result = await generateIntoBank(org, { chapterId: await authoredChapter(), ...ask });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    // The reason is the validator's own sentence, not a generic refusal.
    expect(result.rejected[0]!.reason).toContain("AA criterion");
  });

  it("keeps a flagged question and puts the warning on the row", async () => {
    // A flag is a judgement, and a machine overruling a teacher on a judgement
    // is how a product gets turned off. It reaches them, with the reason.
    const org = await makeOrg();
    scriptRun([good()], {
      verdicts: [
        {
          index: 0,
          reject: false,
          reasons: [
            {
              code: "implausible-distractors",
              note: "Option C is not a similarity criterion at all, so nobody will pick it.",
            },
          ],
        },
      ],
    });

    const result = await generateIntoBank(org, {
      chapterId: await authoredChapter(),
      ...ask,
      count: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toHaveLength(1);

    const saved = await withTenant(org.organizationId, (tx) =>
      tx.question.findUniqueOrThrow({ where: { id: result.created[0]! } }),
    );
    const flags = saved.aiFlags as { code: string; note: string }[];
    expect(flags).toHaveLength(1);
    expect(flags[0]!.code).toBe("implausible-distractors");
    expect(flags[0]!.note).toContain("Option C");
    // Flagged, not blocked: still a draft waiting for a person.
    expect(saved.status).toBe("DRAFT");
  });

  it("treats a reject with no rejecting reason as a flag", async () => {
    // A contradiction, and the conservative reading is the one that keeps a
    // teacher's question.
    const org = await makeOrg();
    scriptRun([good()], {
      verdicts: [
        {
          index: 0,
          reject: true,
          reasons: [{ code: "reading-level", note: "The wording is dense for Class 10." }],
        },
      ],
    });

    const result = await generateIntoBank(org, {
      chapterId: await authoredChapter(),
      ...ask,
      count: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toHaveLength(1);
    expect(REJECTING.has("reading-level")).toBe(false);
  });

  it("ignores a verdict pointing at a draft that does not exist", async () => {
    // A model that renumbers lands its verdict on the wrong question, which is
    // worse than no verdict at all.
    const org = await makeOrg();
    scriptRun([good()], {
      verdicts: [
        { index: 7, reject: true, reasons: [{ code: "out-of-scope", note: "Not in this chapter." }] },
      ],
    });

    const result = await generateIntoBank(org, {
      chapterId: await authoredChapter(),
      ...ask,
      count: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toHaveLength(1);
  });
});

describe("when the validator cannot run", () => {
  it("still gives the teacher the drafts, unflagged", async () => {
    // AI is never on a blocking path. A validator that is down must not mean a
    // teacher gets nothing — they are the last gate either way.
    const org = await makeOrg();
    mock.script({ kind: "ok", value: { questions: [good()] } });
    mock.always = { kind: "error", message: "validator is down" };

    const result = await generateIntoBank(org, {
      chapterId: await authoredChapter(),
      ...ask,
      count: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toHaveLength(1);

    const saved = await withTenant(org.organizationId, (tx) =>
      tx.question.findUniqueOrThrow({ where: { id: result.created[0]! } }),
    );
    expect(saved.aiFlags).toBeNull();
  });
});

describe("the validation prompt", () => {
  it("tells the model that silence is the expected answer", async () => {
    // A teacher who learns the warnings are noise stops reading them, and then
    // the one that mattered goes past too.
    const system = buildSystem({
      organizationId: "x",
      userId: "y",
      boardName: "Central Board of Secondary Education",
      gradeLabel: "Class 10",
      subjectName: "Mathematics",
      chapterTitle: "Triangles",
      outcomes: [{ code: "SIM-2", statement: "Prove two triangles similar" }],
      questions: [],
    });
    expect(system).toContain("Say nothing about a question that is fine");
    expect(system).toContain("SIM-2");
  });

  it("is stable, so the prefix caches", () => {
    const base = {
      organizationId: "x",
      userId: "y",
      boardName: "Central Board of Secondary Education",
      gradeLabel: "Class 10",
      subjectName: "Mathematics",
      chapterTitle: "Triangles",
      outcomes: [
        { code: "SIM-2", statement: "Prove two triangles similar" },
        { code: "SIM-1", statement: "State the criteria" },
      ],
      questions: [],
    };
    expect(buildSystem(base)).toBe(
      buildSystem({ ...base, outcomes: [...base.outcomes].reverse() }),
    );
  });
});
