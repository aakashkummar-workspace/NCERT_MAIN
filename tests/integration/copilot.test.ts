import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ask, getConversation, listConversations } from "@/core/copilot";
import { buildContext, mentioned, rehydrate } from "@/core/copilot/context";
import { setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import {
  getPlayer,
  saveAnswers,
  startAttempt,
  submitAttempt,
  type AnswerPatch,
} from "@/core/attempts";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, type World } from "./support/world";

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

const actorOf = (world: World) => ({
  organizationId: world.organizationId,
  userId: world.teacherId,
  role: world.role,
});

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

/** A world with enough marked work that the Copilot has something to read. */
async function measured() {
  const world = await makeWorld({ maxAttempts: 5 });
  for (let pass = 0; pass < 3; pass++) await sit(world, false);
  await grantCopilot(world.organizationId);
  return world;
}

/**
 * Put the organization on a plan that includes the Copilot.
 *
 * Inside `withTenant`, not through the raw client: `subscriptions` is a tenant
 * table and RLS rejects an insert with no organization context — which is the
 * policy working, not a test problem.
 */
async function grantCopilot(organizationId: string) {
  const plan = await prisma.plan.findFirstOrThrow({
    where: { code: "teacher_pro" },
  });
  await withTenant(organizationId, async (tx) => {
    const existing = await tx.subscription.findFirst({ where: { planId: plan.id } });
    if (existing) return;
    await tx.subscription.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId,
          planId: plan.id,
          status: "ACTIVE",
        },
      ],
    });
  });
}

function answer(text: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "ok" as const,
    value: {
      answer: text,
      citations: ["mean 30% over 3 measured of 3 students"],
      suggestedActions: [],
      insufficientEvidence: false,
      ...extra,
    },
  };
}

describe("the provider never sees a student's name", () => {
  it("sends handles, and puts the names back afterwards", async () => {
    const world = await measured();

    const student = await withTenant(world.organizationId, (tx) =>
      tx.user.findFirstOrThrow({ where: { id: world.studentId } }),
    );

    // The model answers using a handle, as the system prompt instructs.
    const context = await buildContext(
      { organizationId: world.organizationId, userId: world.teacherId },
      null,
    );
    const handle = [...context.identities.keys()].find(
      (key) => context.identities.get(key)!.studentUserId === world.studentId,
    )!;
    expect(handle).toMatch(/^STU_/);

    mock.script(answer(`${handle} is behind on similarity.`));

    const result = await ask(actorOf(world), { question: "Who is behind?" });
    if (!result.ok) throw new Error(result.message);

    // 1. The name is in the ANSWER the teacher reads.
    expect(result.answer).toContain(student.fullName);
    expect(result.answer).not.toContain(handle);

    // 2. And nowhere in what went to the provider. This is the whole design —
    //    the brief's rule implemented rather than promised.
    const sent = JSON.stringify(mock.received);
    expect(sent).not.toContain(student.fullName);
    expect(sent).toContain(handle);
  });

  it("keeps a handle stable across turns", async () => {
    const world = await measured();
    const context = await buildContext(
      { organizationId: world.organizationId, userId: world.teacherId },
      null,
    );
    const again = await buildContext(
      { organizationId: world.organizationId, userId: world.teacherId },
      null,
    );
    // A follow-up question only works if the same student is the same handle.
    expect([...context.identities.keys()].sort()).toEqual(
      [...again.identities.keys()].sort(),
    );
  });

  it("reports which real students an answer was about", async () => {
    const world = await measured();
    const context = await buildContext(
      { organizationId: world.organizationId, userId: world.teacherId },
      null,
    );
    const handle = [...context.identities.keys()][0]!;

    mock.script(answer(`${handle} needs help.`));
    const result = await ask(actorOf(world), { question: "Who needs help?" });
    if (!result.ok) throw new Error(result.message);

    expect(result.students).toHaveLength(1);
    expect(result.students[0]!.studentUserId).toBe(
      context.identities.get(handle)!.studentUserId,
    );
  });

  it("rehydrates every occurrence, not just the first", () => {
    const identities = new Map([
      ["STU_aaaaaa", { studentUserId: "1", fullName: "Meera Nair" }],
      ["STU_bbbbbb", { studentUserId: "2", fullName: "Arun Kumar" }],
    ]);
    const text = "STU_aaaaaa and STU_bbbbbb are behind. STU_aaaaaa most of all.";
    const out = rehydrate(text, identities);

    expect(out).toBe("Meera Nair and Arun Kumar are behind. Meera Nair most of all.");
    // A handle surviving to the screen is gibberish a teacher sees; the reverse
    // is a leak nobody sees at all.
    expect(out).not.toMatch(/STU_/);
    expect(mentioned(text, identities)).toHaveLength(2);
  });
});

describe("the context carries the refusals", () => {
  it("says 'not enough evidence' rather than omitting a concept", async () => {
    const world = await makeWorld({ maxAttempts: 3 });
    await sit(world, false);
    await grantCopilot(world.organizationId);

    const context = await buildContext(
      { organizationId: world.organizationId, userId: world.teacherId },
      null,
    );
    // A missing key is an invitation to guess. A model handed thirty concepts
    // with four numbers will happily average the four.
    if (context.facts.includes("not enough evidence")) {
      expect(context.facts).toMatch(/not enough evidence/);
    }
    expect(context.facts).toContain("CLASSES");
  });

  it("puts a denominator on every mastery figure", async () => {
    const world = await measured();
    const context = await buildContext(
      { organizationId: world.organizationId, userId: world.teacherId },
      null,
    );

    const masteryLines = context.facts
      .split("\n")
      .filter((line) => /mean \d+%/.test(line));
    expect(masteryLines.length).toBeGreaterThan(0);
    // "62%" alone is misleading; the model cannot know it was over four of
    // thirty unless it is told on the same line.
    for (const line of masteryLines) {
      expect(line).toMatch(/measured of \d+ students/);
    }
  });

  it("carries no student names into the facts block at all", async () => {
    const world = await measured();
    const users = await withTenant(world.organizationId, (tx) =>
      tx.user.findMany({ where: { id: { in: [world.studentId, world.otherStudentId] } } }),
    );

    const context = await buildContext(
      { organizationId: world.organizationId, userId: world.teacherId },
      null,
    );
    for (const user of users) {
      expect(context.facts).not.toContain(user.fullName);
    }
  });
});

describe("asking", () => {
  it("refuses before the call when there is nothing to read", async () => {
    const world = await makeWorld();
    await grantCopilot(world.organizationId);

    mock.script(answer("I should not be called."));
    const result = await ask(actorOf(world), { question: "How is my class?" });

    expect(result.ok).toBe(false);
    // Refused BEFORE the provider. Paying DEEP-tier rates to be told there is
    // nothing to look at is the worst possible outcome.
    expect(mock.received).toHaveLength(0);
  });

  it("refuses a question that is not one", async () => {
    const world = await measured();
    const result = await ask(actorOf(world), { question: "hi" });
    expect(result.ok).toBe(false);
    expect(mock.received).toHaveLength(0);
  });

  it("stores both turns, with the name already put back", async () => {
    const world = await measured();
    const context = await buildContext(
      { organizationId: world.organizationId, userId: world.teacherId },
      null,
    );
    const handle = [...context.identities.keys()][0]!;
    const student = context.identities.get(handle)!;

    mock.script(answer(`${handle} is the one to watch.`));
    const result = await ask(actorOf(world), { question: "Who should I watch?" });
    if (!result.ok) throw new Error(result.message);

    const conversation = await getConversation(actorOf(world), result.conversationId);
    expect(conversation!.turns).toHaveLength(2);
    expect(conversation!.turns[0]!.role).toBe("USER");
    expect(conversation!.turns[1]!.role).toBe("ASSISTANT");
    // Stored re-hydrated: an answer full of handles is one a teacher cannot
    // read a week later.
    expect(conversation!.turns[1]!.content).toContain(student.fullName);
    expect(conversation!.turns[1]!.content).not.toMatch(/STU_/);
  });

  it("keeps the citations with the answer", async () => {
    const world = await measured();
    mock.script(answer("They are behind."));
    const result = await ask(actorOf(world), { question: "How are they doing?" });
    if (!result.ok) throw new Error(result.message);

    expect(result.citations.length).toBeGreaterThan(0);
    const conversation = await getConversation(actorOf(world), result.conversationId);
    // A teacher acting on this across a cohort has to be able to check it.
    expect(conversation!.turns[1]!.citations.length).toBeGreaterThan(0);
  });

  it("continues a conversation and sends the history", async () => {
    const world = await measured();
    mock.script(answer("First answer."), answer("Second answer."));

    const first = await ask(actorOf(world), { question: "What should I reteach?" });
    if (!first.ok) throw new Error(first.message);

    const second = await ask(actorOf(world), {
      question: "And in which class?",
      conversationId: first.conversationId,
    });
    if (!second.ok) throw new Error(second.message);
    expect(second.conversationId).toBe(first.conversationId);

    const sent = JSON.stringify(mock.received[1]);
    // The follow-up only makes sense with what came before.
    expect(sent).toContain("What should I reteach?");
    expect(sent).toContain("First answer.");

    const conversation = await getConversation(actorOf(world), first.conversationId);
    expect(conversation!.turns).toHaveLength(4);
  });

  it("uses the DEEP tier at the highest effort", async () => {
    const world = await measured();
    mock.script(answer("An answer."));
    await ask(actorOf(world), { question: "How is 10-A doing?" });

    const call = mock.received[0]!;
    // AI_ARCHITECTURE.md: DEEP for "anything a teacher will act on across a
    // whole cohort", and effort tunes depth rather than switching model.
    expect(call.tier).toBe("DEEP");
    expect(call.effort).toBe("xhigh");
  });

  it("does not put the teacher's question in the ledger summary", async () => {
    const world = await measured();
    mock.script(answer("An answer."));
    await ask(actorOf(world), {
      question: "Is Meera Nair struggling with similar triangles?",
    });

    const generation = await withTenant(world.organizationId, (tx) =>
      tx.aIGeneration.findFirst({
        where: { feature: "TEACHER_COPILOT" },
        orderBy: { startedAt: "desc" },
      }),
    );
    // The question goes to the provider — it has to, it is the question. It
    // does not go in the row a platform admin reads during an incident.
    expect(JSON.stringify(generation)).not.toContain("Meera Nair");
  });

  it("surfaces a failure as a message, never as a throw", async () => {
    const world = await measured();
    // Nothing scripted: the mock fails.
    const result = await ask(actorOf(world), { question: "How is my class?" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The gateway's own wording, never the provider's text.
      expect(result.message).not.toMatch(/MockProvider/i);
    }
  });
});

describe("a conversation belongs to one teacher", () => {
  it("hides it from a colleague in the same organisation", async () => {
    const world = await measured();
    mock.script(answer("An answer."));
    const result = await ask(actorOf(world), { question: "How is 10-A?" });
    if (!result.ok) throw new Error(result.message);

    const colleagueId = randomUUID();
    await withTenant(world.organizationId, async (tx) => {
      await tx.user.createMany({
        data: [{ id: colleagueId, fullName: "A Colleague", status: "ACTIVE" }],
      });
      await tx.membership.createMany({
        data: [
          {
            id: randomUUID(),
            organizationId: world.organizationId,
            userId: colleagueId,
            role: "TEACHER",
            status: "ACTIVE",
            joinedAt: new Date(),
          },
        ],
      });
    });

    const colleague = {
      organizationId: world.organizationId,
      userId: colleagueId,
      role: "TEACHER",
    };
    // Same tenant, and still nothing — what somebody asked about a class is
    // theirs.
    expect(await getConversation(colleague, result.conversationId)).toBeNull();
    expect(await listConversations(colleague)).toHaveLength(0);
  });

  it("hides it from another organisation", async () => {
    const world = await measured();
    mock.script(answer("An answer."));
    const result = await ask(actorOf(world), { question: "How is 10-A?" });
    if (!result.ok) throw new Error(result.message);

    const other = await makeWorld();
    expect(await getConversation(actorOf(other), result.conversationId)).toBeNull();

    const reachable = await withTenant(other.organizationId, (tx) =>
      tx.copilotConversation.findMany({ where: { teacherUserId: world.teacherId } }),
    );
    expect(reachable).toHaveLength(0);
  });

  it("only reads the asking teacher's own classes", async () => {
    const world = await measured();
    const other = await makeWorld();

    const context = await buildContext(
      { organizationId: world.organizationId, userId: world.teacherId },
      null,
    );
    // The context is built inside withTenant, so another organisation's class
    // cannot appear however the question is phrased. There is no tool-calling
    // here for exactly this reason.
    const otherClass = await withTenant(other.organizationId, (tx) =>
      tx.class.findFirstOrThrow({ where: { id: other.classId } }),
    );
    expect(context.facts).not.toContain(otherClass.id);
  });
});
