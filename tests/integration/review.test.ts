import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateOutcome } from "@/core/curriculum/admin";
import { createConcept, linkOutcome } from "@/core/curriculum/concept-admin";
import { approveConcept, approveOutcome, chapterReview, confirmTag } from "@/core/curriculum/review";
import { prisma } from "@/db/client";
import { platformPrisma } from "@/db/platform";
import { withTenant } from "@/db/tenant";
import { fixtureChapter, fixtureOutcome } from "./support/fixture-curriculum";
import { makeWorld, teacherOf, type World } from "./support/world";

/**
 * Review stamps are claims that a person read something. These tests pin the
 * two properties that keep the claim true: an approval is recorded against
 * exactly what was approved, and any edit afterwards takes it away.
 */

let world: World;
let actor: { organizationId: string; userId: string };
const previousSource = process.env.QUESTION_LIBRARY_SOURCE;

afterAll(async () => {
  if (previousSource === undefined) delete process.env.QUESTION_LIBRARY_SOURCE;
  else process.env.QUESTION_LIBRARY_SOURCE = previousSource;
  await prisma.$disconnect();
  await platformPrisma.$disconnect();
});

beforeAll(async () => {
  world = await makeWorld();
  actor = { organizationId: world.organizationId, userId: teacherOf(world).userId };
  // This suite's own world is the library for the tag tests — never the real bank.
  const org = await withTenant(world.organizationId, (tx) =>
    tx.organization.findUniqueOrThrow({ where: { id: world.organizationId }, select: { slug: true } }),
  );
  process.env.QUESTION_LIBRARY_SOURCE = org.slug;
  await withTenant(world.organizationId, (tx) =>
    tx.question.updateMany({ where: { id: { in: world.questionIds } }, data: { provenance: "ORIGINAL" } }),
  );
});

describe("outcomes", () => {
  it("an approval is stamped, and an edit takes it away", async () => {
    const { topicId } = await fixtureChapter({ label: "Review" });
    const outcome = await fixtureOutcome(topicId, "RV");

    expect(await approveOutcome(actor, outcome.id)).toBe(true);
    const approved = await platformPrisma.learningOutcome.findUniqueOrThrow({ where: { id: outcome.id } });
    expect(approved.reviewedAt).not.toBeNull();
    expect(approved.reviewedById).toBe(actor.userId);

    await updateOutcome(actor, outcome.id, {
      code: outcome.code,
      statement: "Apply the reworded idea to a worked problem in two steps.",
      bloomLevel: "APPLY",
      competency: "APPLICATION",
      typicalMarks: 2,
    });
    const edited = await platformPrisma.learningOutcome.findUniqueOrThrow({ where: { id: outcome.id } });
    // The review was given to the previous wording.
    expect(edited.reviewedAt).toBeNull();
  });
});

describe("concepts", () => {
  it("regrouping a reviewed concept sends it back to review", async () => {
    const { topicId } = await fixtureChapter({ label: "Review concept" });
    const created = await createConcept(actor, { name: `Reviewed idea ${randomUUID().slice(0, 8)}` });
    if (!created.ok) throw new Error("create failed");

    expect(await approveConcept(actor, created.id)).toBe(true);
    expect((await platformPrisma.concept.findUniqueOrThrow({ where: { id: created.id } })).reviewedAt).not.toBeNull();

    const outcome = await fixtureOutcome(topicId, "RVC");
    await linkOutcome(actor, created.id, outcome.id, 1);
    expect((await platformPrisma.concept.findUniqueOrThrow({ where: { id: created.id } })).reviewedAt).toBeNull();
  });
});

describe("question tags", () => {
  it("confirms a tag, moves one within the chapter, and refuses one from another chapter", async () => {
    const [questionId] = world.questionIds as [string];
    const chapter = await chapterReview(world.chapterId);
    expect(chapter?.questions.map((q) => q.id)).toContain(questionId);

    // Confirm as filed.
    const kept = await confirmTag(actor, questionId, world.outcomeId);
    expect(kept).toEqual({ ok: true, changed: false });

    // Move to a sibling outcome in the same chapter, then back.
    const sibling = chapter!.outcomes.find((o) => o.id !== world.outcomeId)!;
    expect(await confirmTag(actor, questionId, sibling.id)).toEqual({ ok: true, changed: true });
    const moved = await withTenant(world.organizationId, (tx) =>
      tx.question.findUniqueOrThrow({ where: { id: questionId }, include: { outcomes: true } }),
    );
    expect(moved.primaryOutcomeId).toBe(sibling.id);
    expect(moved.outcomes.map((o) => o.learningOutcomeId)).toEqual([sibling.id]);
    expect(moved.tagReviewedAt).not.toBeNull();
    await confirmTag(actor, questionId, world.outcomeId);

    // An outcome from a different chapter would send the evidence to the wrong syllabus.
    const { topicId } = await fixtureChapter({ label: "Elsewhere" });
    const elsewhere = await fixtureOutcome(topicId, "RVX");
    const refused = await confirmTag(actor, questionId, elsewhere.id);
    expect(refused.ok).toBe(false);
  });

  it("does not touch a question that is not in the library", async () => {
    const other = await makeWorld();
    const result = await confirmTag(actor, other.questionIds[0]!, other.outcomeId);
    expect(result.ok).toBe(false);
  });
});
