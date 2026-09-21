import { afterAll, describe, expect, it } from "vitest";
import { approveQuestion, createQuestion, draftCounts, rejectQuestion, reviewQueue } from "@/core/questions";
import { prisma } from "@/db/client";
import { makeWorld, teacherOf, type World } from "./support/world";
import { textToken } from "./support/text-token";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The review queue: the drafts a reviewer reads next, and how many are left.
 */

async function draft(world: World, label: string) {
  const created = await createQuestion(teacherOf(world), {
    type: "MCQ",
    subjectId: world.subjectId,
    chapterId: world.chapterId,
    difficulty: "EASY",
    marks: 1,
    stem: `Review queue ${label} ${textToken()}: which criterion needs two pairs of equal angles?`,
    options: [
      { key: "A", text: "AA", isCorrect: true },
      { key: "B", text: "SSS", isCorrect: false },
    ],
    explanation: "Two equal angles force the third.",
    outcomeIds: [world.outcomeId],
  });
  if (!created.ok) throw new Error(`draft failed: ${created.code}`);
  return created.id;
}

describe("the review queue", () => {
  it("holds only drafts, oldest first, with the count still to review", async () => {
    const world = await makeWorld();
    const first = await draft(world, "first");
    const second = await draft(world, "second");

    const queue = await reviewQueue(world.organizationId, { subjectId: world.subjectId });
    const ids = queue.items.map((item) => item.id);
    // makeWorld's own questions are approved, so they are not in the queue.
    expect(ids).toEqual([first, second]);
    expect(queue.remaining).toBe(2);
    expect(queue.items[0]).toMatchObject({ status: "DRAFT", validation: { approvable: true } });
  });

  it("drops a question once it is approved or rejected, and keeps a skipped one", async () => {
    const world = await makeWorld();
    const [a, b, c] = [await draft(world, "a"), await draft(world, "b"), await draft(world, "c")];

    await approveQuestion(teacherOf(world), a);
    await rejectQuestion(teacherOf(world), b, "The distractor is ambiguous.");

    // The reviewer skipped nothing, so the next batch starts at the beginning
    // of what is still a draft.
    let queue = await reviewQueue(world.organizationId, { subjectId: world.subjectId });
    expect(queue.items.map((item) => item.id)).toEqual([c]);

    // Skipping c moves the next batch past it without losing it.
    queue = await reviewQueue(world.organizationId, { subjectId: world.subjectId }, 1);
    expect(queue.items).toEqual([]);
    expect(queue.remaining).toBe(1);
  });

  it("counts drafts per subject and chapter for the pickers", async () => {
    const world = await makeWorld();
    await draft(world, "one");
    await draft(world, "two");
    const counts = await draftCounts(world.organizationId);
    expect(counts.total).toBe(2);
    expect(counts.bySubject.get(world.subjectId)).toBe(2);
    expect(counts.byChapter.get(world.chapterId)).toBe(2);
  });

  it("shows one organization nothing of another's drafts", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    await draft(world, "private");
    const queue = await reviewQueue(other.organizationId, {});
    expect(queue.items).toEqual([]);
    expect((await draftCounts(other.organizationId)).total).toBe(0);
  });
});
