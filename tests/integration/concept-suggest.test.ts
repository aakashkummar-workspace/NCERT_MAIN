import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { draftConcepts } from "@/core/curriculum/concept-suggest";
import {
  createConcept,
  createConceptWithOutcomes,
  linkUncoveredOutcomes,
  uncoveredOutcomes,
} from "@/core/curriculum/concept-admin";
import { MAX_OUTCOMES_PER_CALL } from "@/core/curriculum/concept-suggest";
import { outcomeIdsFor } from "@/core/curriculum/concepts";
import { setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import { signUp } from "@/core/identity/accounts";
import { prisma } from "@/db/client";
import { platformPrisma } from "@/db/platform";
import { fixtureChapter, fixtureOutcome } from "./support/fixture-curriculum";
import { withTenant } from "@/db/tenant";

afterAll(async () => {
  await prisma.$disconnect();
  await platformPrisma.$disconnect();
});

let mock: MockProvider;
let actor: { organizationId: string; userId: string };
let subjectId: string;
let topicId: string;

beforeEach(() => {
  mock = new MockProvider();
  setProvider(mock);
});

afterEach(() => {
  setProvider(null);
});

beforeAll(async () => {
  const signup = await signUp({
    fullName: "Suggest Author",
    email: `suggest-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: `Suggest Org ${randomUUID().slice(0, 6)}`,
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!signup.ok) throw new Error("signUp failed");
  const membership = await withTenant(signup.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );
  actor = { organizationId: signup.organizationId, userId: membership.userId };

  // Its own chapter, never a seeded topic: outcomes authored into a real
  // syllabus are there for every school to see, permanently.
  const fixture = await fixtureChapter({ label: "Concept suggest" });
  topicId = fixture.topicId;
  subjectId = fixture.subjectId;
});

/** Uncovered outcomes this suite owns, so it never fights over the seeded ones. */
async function makeOutcomes(count: number) {
  const made = [];
  for (let index = 0; index < count; index++) {
    made.push(await fixtureOutcome(topicId, "SG"));
  }
  return made;
}

function proposals(value: unknown) {
  return { kind: "ok" as const, value };
}

describe("it refuses before it spends", () => {
  it("says so when a subject has no uncovered outcomes", async () => {
    // Its OWN subject, with no chapters at all — rather than sweeping the
    // shared one, which would permanently empty the worklist that other suites
    // and the smoke checks read. A test that has to mutate global state to make
    // its precondition true should build its own instead.
    // One fixed fixture subject, reused across runs rather than a new one
    // each time — the same one the readiness suite uses, and for the same
    // reason: nothing authors chapters into it.
    const grade = await platformPrisma.grade.findFirstOrThrow({
      where: { number: 10, board: { code: "CBSE" } },
    });
    const empty = await platformPrisma.subject.upsert({
      where: { gradeId_code: { gradeId: grade.id, code: "ZZNOCHAPTERS" } },
      update: {},
      create: {
        gradeId: grade.id,
        code: "ZZNOCHAPTERS",
        name: "Test fixture – no chapters",
        shortName: "Test fixture",
      },
    });

    const result = await draftConcepts(actor, { subjectId: empty.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("nothing-uncovered");
    // Paying a model to be told there is nothing to group is the worst
    // outcome available.
    expect(mock.callCount).toBe(0);
  });
});

describe("what reaches the reviewer", () => {
  it("keeps a well-formed proposal and resolves its outcomes", async () => {
    await makeOutcomes(3);
    // What the model will actually be shown. Indexes refer to THIS list, and
    // the invariant under test is that they resolve into it — not that they
    // land on the three rows this test happened to create, which are only in
    // the window if the shared worklist is short.
    const offered = await uncoveredOutcomes(subjectId, MAX_OUTCOMES_PER_CALL);
    const name = `Grouped ${randomUUID().slice(0, 8)}`;
    mock.script(
      proposals({
        proposals: [
          {
            name,
            description: "The idea these three outcomes share.",
            outcomeIndexes: [0, 1, 2],
            rationale: "All three ask a student to apply the same relationship.",
          },
        ],
      }),
    );

    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);

    const draft = result.drafts.find((item) => item.name === name);
    expect(draft).toBeDefined();
    expect(draft!.outcomes).toHaveLength(3);
    // Resolved to real ids here, so the accept step never has to trust
    // anything the model said about identity.
    for (const outcome of draft!.outcomes) {
      expect(offered.map((row) => row.id)).toContain(outcome.id);
    }
    expect(draft!.outcomes.map((row) => row.id)).toEqual(
      offered.slice(0, 3).map((row) => row.id),
    );
    // Nothing was written. The proposal is a proposal.
    expect(
      await platformPrisma.concept.findFirst({ where: { name } }),
    ).toBeNull();
  });

  it("discards a proposal pointing at an outcome that was not offered", async () => {
    await makeOutcomes(2);
    mock.script(
      proposals({
        proposals: [
          {
            name: `Renumbered ${randomUUID().slice(0, 8)}`,
            description: "Points at an index that does not exist.",
            outcomeIndexes: [9998, 9999],
            rationale: "A model that renumbers lands its grouping on nothing.",
          },
        ],
      }),
    );

    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);
    // Dropped before a person sees it: a reviewer reading proposals of which
    // some are malformed learns to skim, and a reviewer who skims is not a gate.
    expect(result.drafts).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it("keeps the valid half of a partly-bad proposal and says so", async () => {
    await makeOutcomes(3);
    const name = `Partly ${randomUUID().slice(0, 8)}`;
    mock.script(
      proposals({
        proposals: [
          {
            name,
            description: "Two real outcomes and one invented index.",
            outcomeIndexes: [0, 1, 4242],
            rationale: "The first two share an idea; the third does not exist.",
          },
        ],
      }),
    );

    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);
    const draft = result.drafts.find((item) => item.name === name)!;
    expect(draft.outcomes).toHaveLength(2);
    // Trimmed, and the reviewer is told — they should know the grouping in
    // front of them is not quite the one that was proposed.
    expect(draft.flags.join(" ")).toMatch(/did not exist/i);
  });

  it("discards a name that already exists", async () => {
    const taken = `Taken ${randomUUID().slice(0, 8)}`;
    const existing = await createConcept(actor, { name: taken });
    expect(existing.ok).toBe(true);

    await makeOutcomes(2);
    mock.script(
      proposals({
        proposals: [
          {
            name: taken,
            description: "A duplicate of one that exists.",
            outcomeIndexes: [0],
            rationale: "Two concepts with one name are indistinguishable.",
          },
        ],
      }),
    );

    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);
    expect(result.drafts.some((item) => item.name === taken)).toBe(false);
    expect(result.discarded).toBe(1);
  });

  it("discards a second proposal reusing the first one's name", async () => {
    await makeOutcomes(4);
    const name = `Twice ${randomUUID().slice(0, 8)}`;
    mock.script(
      proposals({
        proposals: [
          {
            name,
            description: "The first of two with one name.",
            outcomeIndexes: [0, 1],
            rationale: "These two share an idea.",
          },
          {
            name,
            description: "The second of two with one name.",
            outcomeIndexes: [2, 3],
            rationale: "These two share a different idea.",
          },
        ],
      }),
    );

    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);
    expect(result.drafts.filter((item) => item.name === name)).toHaveLength(1);
    expect(result.discarded).toBe(1);
  });

  it("flags a one-outcome grouping without hiding it", async () => {
    await makeOutcomes(2);
    const name = `Thin ${randomUUID().slice(0, 8)}`;
    mock.script(
      proposals({
        proposals: [
          {
            name,
            description: "One outcome on its own.",
            outcomeIndexes: [0],
            rationale: "Sometimes one outcome really is its own idea.",
          },
        ],
      }),
    );

    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);
    const draft = result.drafts.find((item) => item.name === name)!;
    // Shown, because the reviewer may know better — but a concept with one
    // outcome behind it rarely reaches the evidence threshold.
    expect(draft.flags.join(" ")).toMatch(/one outcome/i);
  });

  it("returns nothing, and no error, when the model proposes nothing", async () => {
    await makeOutcomes(2);
    mock.script(proposals({ proposals: [] }));

    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);
    // An empty list is a real answer: outcomes that share nothing are better
    // left uncovered and visible.
    expect(result.drafts).toHaveLength(0);
    expect(result.discarded).toBe(0);
  });

  it("returns a typed refusal, never a throw, when the provider fails", async () => {
    await makeOutcomes(2);
    mock.always = { kind: "error", message: "provider exploded" };

    const result = await draftConcepts(actor, { subjectId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unavailable");
    // The provider's own words never reach a person.
    expect(result.message).not.toContain("provider exploded");
  });
});

describe("nothing about anybody goes to the provider", () => {
  it("sends curriculum text and no identifiers at all", async () => {
    await makeOutcomes(2);
    mock.script(
      proposals({
        proposals: [
          {
            name: `Clean ${randomUUID().slice(0, 8)}`,
            description: "A clean proposal.",
            outcomeIndexes: [0],
            rationale: "Nothing personal is in this request.",
          },
        ],
      }),
    );

    const offered = await uncoveredOutcomes(subjectId, MAX_OUTCOMES_PER_CALL);
    await draftConcepts(actor, { subjectId });
    const sent = JSON.stringify(mock.received[0]);

    // The one AI task in the product with no personal data in it whatsoever —
    // stated as a claim somebody can check rather than assumed.
    expect(sent).not.toContain(actor.userId);
    expect(sent).not.toContain(actor.organizationId);
    expect(sent).not.toContain("Suggest Author");
    // And the outcome ids stay here: the model works in indexes, so a mistyped
    // uuid cannot become a link to the wrong thing.
    for (const outcome of offered) {
      expect(sent).not.toContain(outcome.id);
    }
  });
});

describe("accepting a draft", () => {
  it("creates the concept and links every outcome in one action", async () => {
    const outcomes = await makeOutcomes(3);
    const name = `Accepted ${randomUUID().slice(0, 8)}`;

    const created = await createConceptWithOutcomes(actor, {
      name,
      description: "Created from a draft.",
      outcomeIds: outcomes.map((outcome) => outcome.id),
    });
    if (!created.ok) throw new Error(JSON.stringify(created.problems));
    expect(created.linked).toBe(3);

    const linked = await outcomeIdsFor(created.id);
    expect(linked).toHaveLength(3);

    // And the outcomes have left the worklist, which is the whole point.
    const stillUncovered = await uncoveredOutcomes(subjectId, 500);
    for (const outcome of outcomes) {
      expect(stillUncovered.map((row) => row.id)).not.toContain(outcome.id);
    }
  });

  it("refuses a duplicate name without creating a half-made concept", async () => {
    const name = `Clash ${randomUUID().slice(0, 8)}`;
    const first = await createConcept(actor, { name });
    expect(first.ok).toBe(true);

    const outcomes = await makeOutcomes(2);
    const second = await createConceptWithOutcomes(actor, {
      name,
      outcomeIds: outcomes.map((outcome) => outcome.id),
    });
    expect(second.ok).toBe(false);

    // The outcomes are untouched: a refused accept must not leave links behind.
    const stillUncovered = await uncoveredOutcomes(subjectId, 500);
    for (const outcome of outcomes) {
      expect(stillUncovered.map((row) => row.id)).toContain(outcome.id);
    }
  });
});

/** What the model is shown as existing concepts, in the order `conceptIndex` refers to. */
async function existingInSubject() {
  return platformPrisma.concept.findMany({
    where: { outcomes: { some: { outcome: { topic: { chapter: { subjectId } } } } } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

describe("adding an outcome to a concept that already exists", () => {
  it("resolves the concept by the index it was listed under", async () => {
    await makeOutcomes(1);
    const offered = await uncoveredOutcomes(subjectId, MAX_OUTCOMES_PER_CALL);
    const existing = await existingInSubject();
    expect(existing.length).toBeGreaterThan(1);
    mock.script(
      proposals({
        proposals: [],
        links: [{ conceptIndex: 1, outcomeIndexes: [0], rationale: "This outcome is the same idea as that concept." }],
      }),
    );

    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);
    expect(result.links).toHaveLength(1);
    // Resolved against the list the model was shown — never an id it echoed.
    expect(result.links[0]!.conceptId).toBe(existing[1]!.id);
    expect(result.links[0]!.conceptName).toBe(existing[1]!.name);
    expect(result.links[0]!.outcomes.map((row) => row.id)).toEqual([offered[0]!.id]);
  });

  it("drops a link to a concept that was not on the list, and counts it", async () => {
    await makeOutcomes(1);
    const existing = await existingInSubject();
    mock.script(
      proposals({
        proposals: [],
        links: [{ conceptIndex: existing.length + 5, outcomeIndexes: [0], rationale: "Points at nothing that was offered." }],
      }),
    );
    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);
    expect(result.links).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it("puts an outcome in one place, never a new concept and a link at once", async () => {
    await makeOutcomes(2);
    mock.script(
      proposals({
        proposals: [
          {
            name: `One place ${randomUUID().slice(0, 8)}`,
            description: "Claims the first two outcomes.",
            outcomeIndexes: [0, 1],
            rationale: "Both apply the same relationship.",
          },
        ],
        links: [{ conceptIndex: 0, outcomeIndexes: [0], rationale: "Claims an outcome the proposal already has." }],
      }),
    );
    const result = await draftConcepts(actor, { subjectId });
    if (!result.ok) throw new Error(result.message);
    expect(result.drafts).toHaveLength(1);
    // Its only outcome was already taken, so nothing was left to link.
    expect(result.links).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it("accepts a link only for an uncovered outcome and a concept in this subject", async () => {
    // A concept of this suite's own, never a real one: concepts have no tenant,
    // and a link written to a real concept would be permanent and global.
    const [first, second] = await makeOutcomes(2);
    const concept = await createConceptWithOutcomes(actor, {
      name: `Link target ${randomUUID().slice(0, 8)}`,
      outcomeIds: [first!.id],
    });
    if (!concept.ok) throw new Error(JSON.stringify(concept.problems));

    const linked = await linkUncoveredOutcomes(actor, concept.id, [second!.id]);
    expect(linked.ok).toBe(true);
    expect(await outcomeIdsFor(concept.id)).toEqual(expect.arrayContaining([first!.id, second!.id]));

    // Covered now, so a second accept of the same proposal is refused.
    const again = await linkUncoveredOutcomes(actor, concept.id, [second!.id]);
    expect(again.ok).toBe(false);

    // A concept that measures a different subject.
    const science = await platformPrisma.subject.findFirstOrThrow({
      where: { code: "SCI", grade: { number: 10, board: { code: "CBSE" } } },
    });
    const elsewhere = await fixtureChapter({ subjectId: science.id, label: "Link elsewhere" });
    const scienceOutcome = await fixtureOutcome(elsewhere.topicId, "SGX");
    const scienceConcept = await createConceptWithOutcomes(actor, {
      name: `Science target ${randomUUID().slice(0, 8)}`,
      outcomeIds: [scienceOutcome.id],
    });
    if (!scienceConcept.ok) throw new Error(JSON.stringify(scienceConcept.problems));
    const [maths] = await makeOutcomes(1);
    const crossed = await linkUncoveredOutcomes(actor, scienceConcept.id, [maths!.id]);
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) expect(crossed.problems[0]!.message).toMatch(/does not measure this subject/);
  });
});
