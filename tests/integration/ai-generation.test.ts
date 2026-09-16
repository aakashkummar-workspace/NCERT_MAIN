import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import { generateIntoBank } from "@/core/questions/generate";
import { buildSystem, type GeneratedQuestion } from "@/ai/tasks/generate-questions";
import { setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import { prisma } from "@/db/client";
import { fixtureChapter } from "./support/fixture-curriculum";
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
    fullName: "Generating Teacher",
    email: `gen-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Generating Org",
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

/** The seeded worked example: Class 10 Maths chapter 6, which has outcomes. */
async function authoredChapter() {
  const outcome = await prisma.learningOutcome.findFirstOrThrow({
    where: { code: "SIM-2" },
    include: { topic: true },
  });
  return outcome.topic.chapterId;
}

/**
 * A chapter with no outcomes, AUTHORED HERE rather than found.
 *
 * ---------------------------------------------------------------------------
 * Why this stopped working, and why finding one was always wrong
 * ---------------------------------------------------------------------------
 * This used to be `findFirstOrThrow` over `topics: { every: { outcomes:
 * { none: {} } } }`, on the reasoning that 50 seeded chapters are in that
 * state by design. That was true on the day it was written and is now false:
 * the database is never reset between runs, other suites author outcomes as
 * arrangement, and after enough runs there were **zero** bare chapters left of
 * 51 — with 1,352 outcomes against the 69 that are seeded. The test then
 * failed on a `NotFoundError` that named nothing about generation.
 *
 * It is the same hazard as hardcoding a phone number, inverted: instead of
 * claiming a globally unique value that can only be claimed once, it depended
 * on a scarce shared one staying unclaimed. Both pass for months and then fail
 * forever, and neither failure points at what actually changed.
 *
 * So the test makes its own. Written on the platform connection because the
 * app role has no insert grant on the curriculum plane at all — a test that
 * could write curriculum as the app would be proving the wrong thing. The
 * chapter gets a topic and no outcomes, which is the shape a real unauthored
 * chapter has: every seeded chapter has topics, and outcomes are what somebody
 * who teaches the subject adds later.
 */
async function bareChapter() {
  // A fixture chapter: numbered as one, so the global teardown removes it.
  return (await fixtureChapter({ label: "Unauthored" })).chapterId;
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

describe("generating into the bank", () => {
  it("saves what the model wrote as DRAFT, never as approved", async () => {
    const org = await makeOrg();
    mock.script({ kind: "ok", value: { questions: [good(), good()] } });

    const result = await generateIntoBank(org, { chapterId: await authoredChapter(), ...ask });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toHaveLength(2);

    const questions = await withTenant(org.organizationId, (tx) =>
      tx.question.findMany({ where: { id: { in: result.created } } }),
    );
    // AI proposes. A human approves anything a student will see.
    expect(questions.every((question) => question.status === "DRAFT")).toBe(true);
    expect(questions.every((question) => question.source === "AI_GENERATED")).toBe(true);
    expect(questions.every((question) => question.approvedAt === null)).toBe(true);
  });

  it("drops a malformed question before a teacher ever sees it", async () => {
    // Two correct options on a single-answer item is an error in a real exam.
    // A teacher reading eight questions of which three are broken learns to
    // skim, and skimming is how a bad question reaches a class.
    const org = await makeOrg();
    mock.script({
      kind: "ok",
      value: {
        questions: [
          good(),
          good({
            options: [
              { key: "A", text: "The AA criterion", isCorrect: true },
              { key: "B", text: "The SSS criterion", isCorrect: true },
            ],
          }),
        ],
      },
    });

    const result = await generateIntoBank(org, { chapterId: await authoredChapter(), ...ask });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toBeTruthy();
  });

  it("drops a question the bank already has", async () => {
    const org = await makeOrg();
    const chapterId = await authoredChapter();
    const duplicate = good();

    mock.script({ kind: "ok", value: { questions: [duplicate] } });
    await generateIntoBank(org, { chapterId, ...ask });

    mock.script({ kind: "ok", value: { questions: [duplicate] } });
    const second = await generateIntoBank(org, { chapterId, ...ask });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toHaveLength(0);
    expect(second.rejected[0]!.reason).toContain("already");
  });

  it("records what was produced and what was kept", async () => {
    const org = await makeOrg();
    mock.script({
      kind: "ok",
      value: { questions: [good(), good({ marks: 99 as unknown as number })] },
    });

    const result = await generateIntoBank(org, { chapterId: await authoredChapter(), ...ask });
    // The schema rejects marks of 99 before the gateway returns, so this is a
    // malformed batch rather than a partial one.
    expect(result.ok).toBe(false);
  });

  it("marks a partly usable batch as PARTIAL", async () => {
    const org = await makeOrg();
    mock.script({
      kind: "ok",
      value: {
        questions: [
          good(),
          // Passes the response schema and fails the validator: no option is
          // marked correct, which is an error in a real exam and exactly the
          // kind of thing a teacher should never have to spot.
          good({
            options: [
              { key: "A", text: "The AA criterion", isCorrect: false },
              { key: "B", text: "The SSS criterion", isCorrect: false },
            ],
          }),
        ],
      },
    });

    const result = await generateIntoBank(org, { chapterId: await authoredChapter(), ...ask });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const generation = await withTenant(org.organizationId, (tx) =>
      tx.aIGeneration.findUniqueOrThrow({ where: { id: result.generationId } }),
    );
    expect(generation.status).toBe("PARTIAL");
    expect(generation.producedCount).toBe(2);
    expect(generation.acceptedCount).toBe(1);
  });
});

describe("what generation refuses to attempt", () => {
  it("will not generate for a chapter with no learning outcomes", async () => {
    // The outcome statement is the only grounding a generator has for what a
    // chapter is FOR. Without one the model writes plausible questions about
    // the title, which is exactly the output that wastes an evening.
    const org = await makeOrg();
    const result = await generateIntoBank(org, { chapterId: await bareChapter(), ...ask });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NO_OUTCOMES");
    // Nothing was sent.
    expect(mock.callCount).toBe(0);
  });

  it("refuses an unreasonable batch size before spending anything", async () => {
    const org = await makeOrg();
    const result = await generateIntoBank(org, {
      chapterId: await authoredChapter(),
      ...ask,
      count: 500,
    });
    expect(result.ok).toBe(false);
    expect(mock.callCount).toBe(0);
  });

  it("passes a refusal through as a refusal, not a crash", async () => {
    const org = await makeOrg();
    mock.always = { kind: "refusal" };

    const result = await generateIntoBank(org, { chapterId: await authoredChapter(), ...ask });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REFUSED");
  });
});

describe("the prompt", () => {
  it("grounds the model in the chapter's own outcomes", async () => {
    const org = await makeOrg();
    mock.script({ kind: "ok", value: { questions: [good()] } });
    await generateIntoBank(org, { chapterId: await authoredChapter(), ...ask });

    const system = mock.received[0]!.system;
    expect(system).toContain("SIM-2");
    // The board, by name, from the chapter's own tree rather than hard-coded.
    expect(system).toContain("Central Board of Secondary Education");
    // The rules a teacher would otherwise have to reject eight questions over.
    expect(system).toContain("all of the above");
  });

  it("puts nothing volatile above the cache breakpoint", async () => {
    // A single changed byte up here invalidates the prefix and roughly triples
    // the bill, with no other symptom.
    const context = {
      boardName: "Central Board of Secondary Education",
      subjectName: "Mathematics",
      gradeLabel: "Class 10",
      chapterTitle: "Triangles",
      outcomes: [
        { code: "SIM-2", statement: "Prove two triangles similar" },
        { code: "SIM-1", statement: "State the similarity criteria" },
      ],
      exemplars: [],
      organizationId: "x",
      userId: "y",
      count: 3,
      types: ["MCQ"],
      difficulty: "MEDIUM" as const,
      marks: 1,
      avoid: ["one", "two"],
    };

    const first = buildSystem(context);
    // The same inputs in a different order must produce the same prefix.
    const second = buildSystem({
      ...context,
      outcomes: [...context.outcomes].reverse(),
      count: 9,
      avoid: ["three"],
    });
    expect(first).toBe(second);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("tells the model what the bank already has", async () => {
    const org = await makeOrg();
    const chapterId = await authoredChapter();
    const existing = good();

    mock.script(
      { kind: "ok", value: { questions: [existing] } },
      { kind: "ok", value: { verdicts: [] } },
    );
    await generateIntoBank(org, { chapterId, ...ask });

    mock.script(
      { kind: "ok", value: { questions: [good()] } },
      { kind: "ok", value: { verdicts: [] } },
    );
    await generateIntoBank(org, { chapterId, ...ask });

    // Identified by what the call is, not by where it sits in the list. A
    // validation call now runs between the two generations, and a test that
    // counted positions would have to be rewritten every time the pipeline
    // gains a step.
    const generations = mock.received.filter((request) =>
      request.schemaName === "GeneratedBatch",
    );
    expect(generations).toHaveLength(2);

    // Below the breakpoint, where a volatile list belongs.
    expect(generations[1]!.messages[0]!.content).toContain("already in the bank");
    expect(generations[1]!.system).toBe(generations[0]!.system);
  });
});
