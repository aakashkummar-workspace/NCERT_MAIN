import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addPrerequisite,
  conceptDetail,
  createConcept,
  linkOutcome,
  listConcepts,
  removePrerequisite,
  renameConcept,
  uncoveredOutcomes,
  unlinkOutcome,
} from "@/core/curriculum/concept-admin";
import { conceptContext, outcomeIdsFor, prerequisitesOf } from "@/core/curriculum/concepts";
import { signUp } from "@/core/identity/accounts";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { platformPrisma } from "@/db/platform";
import { fixtureChapter, fixtureOutcome } from "./support/fixture-curriculum";

afterAll(async () => {
  await prisma.$disconnect();
  await platformPrisma.$disconnect();
});

let actor: { organizationId: string; userId: string };
let topicId: string;

beforeAll(async () => {
  const signup = await signUp({
    fullName: "Concept Author",
    email: `concept-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: `Concept Org ${randomUUID().slice(0, 6)}`,
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!signup.ok) throw new Error("signUp failed");
  // Through the TENANT path, not the platform one: the platform connection
  // holds select policies on four tables that carry no student work, and
  // `memberships` is deliberately not among them.
  const membership = await withTenant(signup.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );
  actor = { organizationId: signup.organizationId, userId: membership.userId };

  // A chapter of this suite's own. This used to take `topic.findFirstOrThrow()`
  // — whichever seeded topic came first — and author every outcome into it, so
  // each run added a dozen "Apply the … idea" outcomes to a real syllabus.
  topicId = (await fixtureChapter({ label: "Concept admin" })).topicId;
});

/** A fresh outcome to link, so tests never fight over the seeded ones. */
function makeOutcome() {
  return fixtureOutcome(topicId, "CA");
}

const uniqueName = (label: string) =>
  `${label} ${randomUUID().slice(0, 8)}`;

describe("creating a concept", () => {
  it("writes it on the platform connection and derives a slug", async () => {
    const name = uniqueName("Similarity of quadrilaterals");
    const created = await createConcept(actor, { name });
    if (!created.ok) throw new Error(JSON.stringify(created.problems));

    const stored = await platformPrisma.concept.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.name).toBe(name);
    expect(stored.slug).toMatch(/^similarity-of-quadrilaterals/);
    // Every curriculum write is audited: a cross-tenant action nobody can
    // reconstruct is a cross-tenant action nobody can defend.
    const audited = await platformPrisma.auditLog.findFirst({
      where: { entityId: created.id, action: "curriculum.concept_created" },
    });
    expect(audited).not.toBeNull();
  });

  it("refuses a name that is not a concept", async () => {
    const created = await createConcept(actor, { name: "x" });
    expect(created.ok).toBe(false);
  });

  it("refuses a duplicate name", async () => {
    const name = uniqueName("Ratio and proportion");
    const first = await createConcept(actor, { name });
    expect(first.ok).toBe(true);

    const second = await createConcept(actor, { name });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    // Two concepts with the same name are indistinguishable on a heatmap
    // column, and whichever a question maps to is a coin toss.
    expect(second.problems[0]!.message).toMatch(/already exists/i);
  });

  it("the app role cannot write a concept at all", async () => {
    // Not a code check — a grant. `sahayak_app` matches no write policy on the
    // curriculum plane, so a teacher-facing route physically cannot author one.
    await expect(
      prisma.concept.create({
        data: { slug: `app-written-${randomUUID().slice(0, 6)}`, name: "App written" },
      }),
    ).rejects.toThrow();
  });
});

describe("renaming", () => {
  it("changes the name and leaves the slug alone", async () => {
    const created = await createConcept(actor, { name: uniqueName("Typo cocnept") });
    if (!created.ok) throw new Error("create failed");
    const before = await platformPrisma.concept.findUniqueOrThrow({
      where: { id: created.id },
    });

    const renamed = await renameConcept(actor, created.id, {
      name: uniqueName("Fixed concept"),
    });
    expect(renamed.ok).toBe(true);

    const after = await platformPrisma.concept.findUniqueOrThrow({
      where: { id: created.id },
    });
    // A slug that follows the name is an identifier nothing can rely on: a seed
    // file and a support ticket both refer to it.
    expect(after.slug).toBe(before.slug);
    expect(after.name).not.toBe(before.name);
  });
});

describe("linking outcomes is what makes a concept measurable", () => {
  it("links, and the tenant-side reader sees it immediately", async () => {
    const created = await createConcept(actor, { name: uniqueName("Linkable") });
    if (!created.ok) throw new Error("create failed");
    const outcome = await makeOutcome();

    const linked = await linkOutcome(actor, created.id, outcome.id, 1);
    expect(linked.ok).toBe(true);

    // The curriculum plane is global and readable by every tenant, so a concept
    // authored here is measurable everywhere on the next answer.
    expect(await outcomeIdsFor(created.id)).toContain(outcome.id);
    const context = await conceptContext([created.id]);
    expect(context.get(created.id)?.name).toBeDefined();
  });

  it("refuses a weight of zero", async () => {
    const created = await createConcept(actor, { name: uniqueName("Weighted") });
    if (!created.ok) throw new Error("create failed");
    const outcome = await makeOutcome();

    const linked = await linkOutcome(actor, created.id, outcome.id, 0);
    expect(linked.ok).toBe(false);
    // A link worth nothing makes coverage claim an outcome is covered when
    // nothing will ever be measured through it.
    expect(await outcomeIdsFor(created.id)).not.toContain(outcome.id);
  });

  it("re-linking updates the weight rather than duplicating", async () => {
    const created = await createConcept(actor, { name: uniqueName("Reweighted") });
    if (!created.ok) throw new Error("create failed");
    const outcome = await makeOutcome();

    await linkOutcome(actor, created.id, outcome.id, 1);
    await linkOutcome(actor, created.id, outcome.id, 0.4);

    const detail = await conceptDetail(created.id);
    expect(detail!.outcomes).toHaveLength(1);
    expect(detail!.outcomes[0]!.weight).toBeCloseTo(0.4);
  });

  it("unlinks without touching what was already measured", async () => {
    const created = await createConcept(actor, { name: uniqueName("Retired") });
    if (!created.ok) throw new Error("create failed");
    const outcome = await makeOutcome();
    await linkOutcome(actor, created.id, outcome.id, 1);

    // Evidence carries its own concept_id, so history keeps its meaning. This
    // is the whole reason unlinking is safe where deleting would not be.
    expect(await unlinkOutcome(actor, created.id, outcome.id)).toBe(true);
    expect(await outcomeIdsFor(created.id)).toHaveLength(0);
    // The concept itself survives, so past estimates remain explainable.
    expect(
      await platformPrisma.concept.findUnique({ where: { id: created.id } }),
    ).not.toBeNull();
  });
});

describe("the prerequisite graph refuses to close a loop", () => {
  async function three() {
    const a = await createConcept(actor, { name: uniqueName("Alpha") });
    const b = await createConcept(actor, { name: uniqueName("Beta") });
    const c = await createConcept(actor, { name: uniqueName("Gamma") });
    if (!a.ok || !b.ok || !c.ok) throw new Error("create failed");
    return { a: a.id, b: b.id, c: c.id };
  }

  it("records a real prerequisite and the reader walks it", async () => {
    const { a, b } = await three();
    const added = await addPrerequisite(actor, a, b, 1);
    expect(added.ok).toBe(true);

    const map = await prerequisitesOf([a]);
    expect(map.get(a)).toContain(b);
  });

  it("refuses a concept requiring itself", async () => {
    const { a } = await three();
    const added = await addPrerequisite(actor, a, a);
    expect(added.ok).toBe(false);
    if (added.ok) return;
    expect(added.problems[0]!.message).toMatch(/its own prerequisite/i);
  });

  it("refuses a loop three deep", async () => {
    const { a, b, c } = await three();
    await addPrerequisite(actor, a, b);
    await addPrerequisite(actor, b, c);

    const closing = await addPrerequisite(actor, c, a);
    expect(closing.ok).toBe(false);
    if (closing.ok) return;
    expect(closing.problems[0]!.message).toMatch(/loop/i);

    // And nothing was written, so root-cause analysis still terminates.
    const map = await prerequisitesOf([c]);
    expect(map.get(c) ?? []).not.toContain(a);
  });

  it("allows a diamond, which is not a loop", async () => {
    const { a, b, c } = await three();
    const d = await createConcept(actor, { name: uniqueName("Delta") });
    if (!d.ok) throw new Error("create failed");

    await addPrerequisite(actor, a, b);
    await addPrerequisite(actor, a, c);
    expect((await addPrerequisite(actor, b, d.id)).ok).toBe(true);
    expect((await addPrerequisite(actor, c, d.id)).ok).toBe(true);
  });

  it("removes one", async () => {
    const { a, b } = await three();
    await addPrerequisite(actor, a, b);
    expect(await removePrerequisite(actor, a, b)).toBe(true);
    expect((await prerequisitesOf([a])).get(a) ?? []).not.toContain(b);
  });

  it("shows both directions on the detail", async () => {
    const { a, b } = await three();
    await addPrerequisite(actor, a, b);

    const downstream = await conceptDetail(a);
    const upstream = await conceptDetail(b);
    expect(downstream!.prerequisites.map((p) => p.id)).toContain(b);
    // Deleting is not the only way to break somebody — unlinking an outcome
    // that a dependent leans on is, so the dependents are named.
    expect(upstream!.requiredBy.map((p) => p.id)).toContain(a);
  });
});

describe("the coverage worklist", () => {
  it("lists outcomes nothing measures, and drops them once linked", async () => {
    const outcome = await makeOutcome();

    // A limit big enough to hold the whole set, not the 200-row default.
    //
    // `uncoveredOutcomes` is paged, and this database is shared and never
    // reset: once there are more than 200 uncovered outcomes, a freshly
    // created one falls outside the window and "is it listed" stops being the
    // question the assertion thinks it is asking. It failed exactly that way.
    // The same mistake the sibling suite made and fixed — asserting on which
    // rows happen to be on the page rather than on the property.
    const WHOLE_SET = 10_000;

    const before = await uncoveredOutcomes(undefined, WHOLE_SET);
    expect(before.map((row) => row.id)).toContain(outcome.id);

    const created = await createConcept(actor, { name: uniqueName("Coverer") });
    if (!created.ok) throw new Error("create failed");
    await linkOutcome(actor, created.id, outcome.id, 1);

    const after = await uncoveredOutcomes(undefined, WHOLE_SET);
    // An outcome no concept covers can be tested, scored and released and will
    // never inform a mastery figure. This is the list that fixes that.
    expect(after.map((row) => row.id)).not.toContain(outcome.id);
  });

  it("carries enough context to act on a row", async () => {
    const rows = await uncoveredOutcomes(undefined, 5);
    for (const row of rows) {
      expect(row.subjectName.length).toBeGreaterThan(0);
      expect(row.chapterTitle.length).toBeGreaterThan(0);
      expect(row.statement.length).toBeGreaterThan(0);
    }
  });
});

describe("the list", () => {
  it("carries the counts the console needs", async () => {
    const created = await createConcept(actor, { name: uniqueName("Counted") });
    if (!created.ok) throw new Error("create failed");
    const outcome = await makeOutcome();
    await linkOutcome(actor, created.id, outcome.id, 1);

    const rows = await listConcepts();
    const row = rows.find((candidate) => candidate.id === created.id);
    expect(row?.outcomeCount).toBe(1);
    expect(row?.subjects.length).toBeGreaterThan(0);
  });
});
