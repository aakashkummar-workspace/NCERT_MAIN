import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { askForHelp, helpSoFar, DAILY_TURNS_PER_STUDENT } from "@/core/tutor";
import { setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, type World } from "./support/world";

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

const student = (world: World) => ({
  organizationId: world.organizationId,
  userId: world.studentId,
});

function reply(content: string, needsMoreBasics = false) {
  return { kind: "ok" as const, value: { content, needsMoreBasics } };
}

/**
 * A world whose plan includes the tutor.
 *
 * Inside `withTenant`: `subscriptions` is a tenant table and an insert with no
 * organization context is rejected by RLS, which is the policy working.
 */
async function grantTutor(organizationId: string) {
  const plan = await prisma.plan.findFirstOrThrow({ where: { code: "teacher_pro" } });
  await withTenant(organizationId, async (tx) => {
    const existing = await tx.subscription.findFirst({ where: { planId: plan.id } });
    if (existing) return;
    await tx.subscription.createMany({
      data: [{ id: randomUUID(), organizationId, planId: plan.id, status: "ACTIVE" }],
    });
  });
}

async function tutored() {
  const world = await makeWorld();
  await grantTutor(world.organizationId);
  return world;
}

describe("the plan comes before the question", () => {
  it("says it is not included, rather than that nothing was found", async () => {
    // No subscription at all: the free fallback has no tutor row, and a
    // missing entitlement is "not included", never "unlimited".
    const world = await makeWorld();

    const result = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/plan/i);
    // And the model was never reached — a refusal that costs money is not a
    // refusal, it is a purchase.
    expect(mock.callCount).toBe(0);
  });

  it("refuses a question that does not exist, once the plan allows it", async () => {
    const world = await tutored();
    const result = await askForHelp(student(world), { questionId: randomUUID() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/could not find/i);
    expect(mock.callCount).toBe(0);
  });
});

describe("the ladder", () => {
  it("starts at a hint and climbs one rung per ask", async () => {
    const world = await tutored();
    mock.script(
      reply("Count how many facts the question actually gives you."),
      reply("1. Write down what you are given. 2. Name the pairs. 3. Compare."),
      reply("Think of two photographs of the same thing at different sizes."),
    );

    const first = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });
    expect(first.ok && first.level).toBe("HINT");
    expect(first.ok && first.canEscalate).toBe(true);

    const second = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });
    expect(second.ok && second.level).toBe("STEPS");

    const third = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });
    expect(third.ok && third.level).toBe("EXPLAIN");
    expect(third.ok && third.canEscalate).toBe(false);
  });

  it("returns the last turn again at the top, without paying for a fourth", async () => {
    const world = await tutored();
    mock.script(
      reply("Start from what you have actually been given."),
      reply("Write down the pairs first, then compare them one at a time."),
      reply("Picture the same shape photographed at two different sizes."),
    );

    for (let i = 0; i < 3; i++) {
      await askForHelp(student(world), { questionId: world.questionIds[0]! });
    }
    const callsAfterThree = mock.callCount;

    const fourth = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });
    expect(fourth.ok && fourth.content).toBe(
      "Picture the same shape photographed at two different sizes.",
    );
    expect(fourth.ok && fourth.canEscalate).toBe(false);
    // The whole point: no fourth phrasing of the same idea at a fourth cost.
    expect(mock.callCount).toBe(callsAfterThree);
  });

  it("builds on what was already said, rather than starting over", async () => {
    const world = await tutored();
    mock.script(reply("Count the facts you are given."), reply("Now the method."));

    await askForHelp(student(world), { questionId: world.questionIds[0]! });
    await askForHelp(student(world), { questionId: world.questionIds[0]! });

    const secondPrompt = JSON.stringify(mock.received[1]);
    expect(secondPrompt).toContain("Count the facts you are given.");
  });

  it("keeps one session per question, so escalation cannot be reset", async () => {
    const world = await tutored();
    mock.always = reply("Start from what the question actually gives you.");

    await askForHelp(student(world), { questionId: world.questionIds[0]! });
    await askForHelp(student(world), { questionId: world.questionIds[0]! });

    const sessions = await withTenant(world.organizationId, (tx) =>
      tx.tutorSession.findMany({
        where: { studentUserId: world.studentId, questionId: world.questionIds[0]! },
      }),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.maxLevel).toBe("STEPS");
  });
});

describe("the guard", () => {
  it("withholds a reply that hands over the answer, and stamps the turn", async () => {
    const world = await tutored();

    // The answer key for these questions is option A. A model that says so is
    // doing the one thing the whole feature exists to prevent.
    mock.script(
      reply("The answer is A. Just tick that one and move on to the next."),
    );

    const result = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.withheld).toBe(true);
    expect(result.content).not.toContain("Just tick that one");

    // Counted rather than hidden: if this is not rare, the prompt is wrong and
    // somebody has to be able to see that.
    const turns = await withTenant(world.organizationId, (tx) =>
      tx.tutorTurn.findMany({ where: { wasWithheld: true } }),
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]!.content).toBe(result.content);
  });

  it("lets a reply through that teaches without telling", async () => {
    const world = await tutored();
    const taught = "Look at what the question gives you before you count anything.";
    mock.script(reply(taught));

    const result = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });
    expect(result.ok && result.withheld).toBe(false);
    expect(result.ok && result.content).toBe(taught);
  });

  it("still records the turn when the model was reached and refused", async () => {
    const world = await tutored();
    mock.always = { kind: "error", message: "provider down" };

    const result = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The provider's own words never reach a student.
    expect(result.message).not.toContain("provider down");

    // And nothing was written, so the next ask is still a HINT rather than
    // finding itself halfway up a ladder nobody climbed.
    const history = await helpSoFar(student(world), world.questionIds[0]!);
    expect(history).toBeNull();

    // With no authored hint to fall back on, it says so once and does not
    // invite a retry: "try again in a moment", forever, is how a button
    // teaches a student the feature is broken.
    expect(result.retryable).toBe(false);
  });

  it("serves the authored hint when the model cannot be reached", async () => {
    const world = await tutored();
    mock.always = { kind: "error", message: "provider down" };

    const hint = "Write down which sides you have been given before you compare anything.";
    await withTenant(world.organizationId, async (tx) => {
      const question = await tx.question.findFirstOrThrow({
        where: { id: world.questionIds[0]! },
        select: { currentVersionId: true },
      });
      await tx.questionVersion.update({
        where: { id: question.currentVersionId! },
        data: { hint },
      });
    });

    const first = await askForHelp(student(world), { questionId: world.questionIds[0]! });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.level).toBe("HINT");
    expect(first.content).toBe(hint);
    // Not a leak, so not counted as one.
    expect(first.withheld).toBe(false);

    // The next rung cannot be the same nudge relabelled "the method", so it
    // refuses — once, plainly, and not as something to retry.
    const second = await askForHelp(student(world), { questionId: world.questionIds[0]! });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.retryable).toBe(false);
    expect(second.message).not.toContain("provider down");
  });
});

describe("the daily cap", () => {
  it("stops one student spending the whole school's month in an afternoon", async () => {
    const world = await tutored();
    mock.always = reply("Look again at what the question gives you first.");

    // One real ask, to get a session to hang the rest off.
    const first = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Then fill the day up. Written directly rather than through the ladder:
    // reaching the cap the long way would need thirteen questions in the bank,
    // and what is under test is the count, not how it was reached.
    await withTenant(world.organizationId, (tx) =>
      tx.tutorTurn.createMany({
        data: Array.from({ length: DAILY_TURNS_PER_STUDENT - 1 }, () => ({
          id: randomUUID(),
          organizationId: world.organizationId,
          sessionId: first.sessionId,
          level: "HINT" as const,
          content: "An earlier hint, given to this student today.",
        })),
      }),
    );

    const callsBefore = mock.callCount;
    const refused = await askForHelp(student(world), {
      questionId: world.questionIds[1]!,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toMatch(/tomorrow/i);
    // Refused before the model, so the cap costs nothing to enforce.
    expect(mock.callCount).toBe(callsBefore);
  });

  it("counts today only, so yesterday's asks do not follow them into today", async () => {
    const world = await tutored();
    mock.always = reply("Look again at what the question gives you first.");

    const first = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await withTenant(world.organizationId, (tx) =>
      tx.tutorTurn.createMany({
        data: Array.from({ length: DAILY_TURNS_PER_STUDENT * 2 }, () => ({
          id: randomUUID(),
          organizationId: world.organizationId,
          sessionId: first.sessionId,
          level: "HINT" as const,
          content: "A hint from yesterday, which is not today's business.",
          createdAt: yesterday,
        })),
      }),
    );

    const today = await askForHelp(student(world), {
      questionId: world.questionIds[1]!,
    });
    expect(today.ok).toBe(true);
  });

  it("does not count another student's asks against this one", async () => {
    const world = await tutored();
    mock.always = reply("Look again at what the question gives you first.");

    const theirs = await askForHelp(
      { organizationId: world.organizationId, userId: world.otherStudentId },
      { questionId: world.questionIds[0]! },
    );
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;

    await withTenant(world.organizationId, (tx) =>
      tx.tutorTurn.createMany({
        data: Array.from({ length: DAILY_TURNS_PER_STUDENT * 2 }, () => ({
          id: randomUUID(),
          organizationId: world.organizationId,
          sessionId: theirs.sessionId,
          level: "HINT" as const,
          content: "Somebody else's hint, on somebody else's afternoon.",
        })),
      }),
    );

    const mine = await askForHelp(student(world), {
      questionId: world.questionIds[0]!,
    });
    expect(mine.ok).toBe(true);
  });
});

describe("what the student can read back", () => {
  it("returns nothing for a question never asked about", async () => {
    const world = await tutored();
    // Not a 404 anywhere: "you have not asked about this yet" is the ordinary
    // state, and the panel opens on it.
    expect(await helpSoFar(student(world), world.questionIds[0]!)).toBeNull();
  });

  it("returns the turns in order once there are some", async () => {
    const world = await tutored();
    mock.script(
      reply("The first thing to look at is what you are given."),
      reply("The second thing is how those two quantities relate."),
    );
    await askForHelp(student(world), { questionId: world.questionIds[0]! });
    await askForHelp(student(world), { questionId: world.questionIds[0]! });

    const history = await helpSoFar(student(world), world.questionIds[0]!);
    expect(history?.turns.map((turn) => turn.content)).toEqual([
      "The first thing to look at is what you are given.",
      "The second thing is how those two quantities relate.",
    ]);
    expect(history?.maxLevel).toBe("STEPS");
    expect(history?.canEscalate).toBe(true);
  });

  it("shows one student nothing of another's", async () => {
    const world = await tutored();
    mock.always = reply("Look again at what the question gives you first.");
    await askForHelp(student(world), { questionId: world.questionIds[0]! });

    const other = {
      organizationId: world.organizationId,
      userId: world.otherStudentId,
    };
    expect(await helpSoFar(other, world.questionIds[0]!)).toBeNull();
  });
});

describe("the version they were served", () => {
  it("helps with the version on the session, not a later edit", async () => {
    const world = await tutored();
    mock.always = reply("A nudge at the given quantities.");
    await askForHelp(student(world), { questionId: world.questionIds[0]! });

    const session = await withTenant(world.organizationId, (tx) =>
      tx.tutorSession.findFirstOrThrow({
        where: { questionId: world.questionIds[0]! },
      }),
    );
    expect(session.questionVersionId).not.toBeNull();

    // Move the question on. The stored session must not follow it.
    const newVersionId = randomUUID();
    await withTenant(world.organizationId, async (tx) => {
      const current = await tx.questionVersion.findFirstOrThrow({
        where: { id: session.questionVersionId! },
      });
      await tx.questionVersion.createMany({
        data: [
          {
            id: newVersionId,
            questionId: current.questionId,
            version: current.version + 1,
            stem: "A completely different question about something else.",
            options: current.options ?? undefined,
            answerKey: current.answerKey ?? undefined,
            createdById: world.teacherId,
          },
        ],
      });
      await tx.question.update({
        where: { id: current.questionId },
        data: { currentVersionId: newVersionId },
      });
    });

    mock.script(reply("Still working from the question you were served."));
    await askForHelp(student(world), { questionId: world.questionIds[0]! });

    const secondPrompt = JSON.stringify(mock.received[1]);
    expect(secondPrompt).not.toContain("something else");
  });
});
