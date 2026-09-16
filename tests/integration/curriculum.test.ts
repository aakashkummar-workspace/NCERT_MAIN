import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "@/core/identity/accounts";
import {
  addOutcome,
  addTopic,
  chapterDetail,
  chaptersForSubject,
  curriculumOverview,
  deleteOutcome,
  deleteTopic,
  renameTopic,
  updateOutcome,
} from "@/core/curriculum/admin";
import { prisma } from "@/db/client";
import { platformPrisma } from "@/db/platform";
import { FIXTURE_CHAPTER_FLOOR, fixtureChapterNumber } from "../../scripts/lib/fixture-curriculum.mjs";
import { withTenant } from "@/db/tenant";

afterAll(async () => {
  await prisma.$disconnect();
});

let actor: { userId: string; organizationId: string };
let chapterId: string;

beforeAll(async () => {
  const result = await signUp({
    fullName: "Platform Person",
    email: `platform-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Platform Org",
    organizationType: "SOLO_TEACHER",
    boardCode: "CBSE",
  });
  if (!result.ok) throw new Error("signUp failed");

  const membership = await withTenant(result.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );
  actor = { userId: membership.userId, organizationId: result.organizationId };

  // A chapter of this suite's own, with no topics, so the tests do not disturb
  // the worked example.
  //
  // This used to be `findFirstOrThrow({ where: { topics: { none: {} } } })`,
  // which is a test hunting for a scarce shared row — and worse, a suite that
  // CONSUMES one every time it runs, because the first thing it does is add a
  // topic to whatever it found. The database is never reset, so it ate its own
  // supply: 51 chapters, zero of them topic-less, and the suite then failed in
  // `beforeAll` with a Prisma "no record was found" that named nothing about
  // curriculum authoring.
  //
  // Written on the platform connection because the app role has no insert grant
  // on the curriculum plane at all — the same reason `prisma` cannot be used
  // here even though it is imported for the reads below.
  const seed = await platformPrisma.chapter.findFirstOrThrow({
    select: { subjectId: true },
  });
  // A fixture number, so the global teardown removes the chapter and all this
  // suite writes into it.
  const number = fixtureChapterNumber();
  const chapter = await platformPrisma.chapter.create({
    data: {
      subjectId: seed.subjectId,
      number,
      title: `Authoring fixture ${number}`,
      source: "integration test — a chapter this suite writes topics into",
    },
  });
  chapterId = chapter.id;
});

const outcome = {
  code: "T-1",
  statement:
    "Applies the sine rule to find an unknown side of a triangle, and states when it cannot be used.",
  bloomLevel: "APPLY" as const,
  competency: "APPLICATION" as const,
  typicalMarks: 3,
};

describe("the curriculum plane is readable by tenants and writable by none", () => {
  it("a tenant can read chapters", async () => {
    const count = await withTenant(actor.organizationId, (tx) =>
      tx.chapter.count(),
    );
    expect(count).toBeGreaterThan(0);
  });

  it("a tenant cannot insert a chapter", async () => {
    // The whole two-plane model rests on this. If a tenant could write here,
    // "Mathematics" would be a different row in every organization and there
    // would be no cross-tenant intelligence left to build.
    const subject = await prisma.subject.findFirstOrThrow();
    await expect(
      withTenant(actor.organizationId, (tx) =>
        tx.chapter.create({
          data: { subjectId: subject.id, number: 999, title: "Invented" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("a tenant cannot insert a learning outcome", async () => {
    const topic = await prisma.topic.findFirstOrThrow();
    await expect(
      withTenant(actor.organizationId, (tx) =>
        tx.learningOutcome.create({
          data: { topicId: topic.id, code: "HACK", statement: "Invented." },
        }),
      ),
    ).rejects.toThrow();
  });

  it("a tenant cannot update or delete a chapter", async () => {
    const chapter = await prisma.chapter.findFirstOrThrow();
    const before = chapter.title;

    const updated = await withTenant(actor.organizationId, (tx) =>
      tx.chapter.updateMany({
        where: { id: chapter.id },
        data: { title: "Renamed by a tenant" },
      }),
    ).catch(() => ({ count: 0 }));
    expect(updated.count).toBe(0);

    const after = await prisma.chapter.findUniqueOrThrow({
      where: { id: chapter.id },
    });
    expect(after.title).toBe(before);
  });
});

describe("the worked example", () => {
  it("is seeded, so the shape of a good outcome is in the database", async () => {
    const chapter = await prisma.chapter.findFirstOrThrow({
      where: {
        number: 6,
        // The BOARD as well as the class year. `subjects` is unique on
        // (grade, code) and every board has its own Class 10 Maths, so
        // "MATH in class 10" names two rows — CBSE's, with fourteen
        // chapters, and ICSE's, which has none authored. `findFirst` may
        // return either, and which one it returns is not a thing a test may
        // depend on. `fixtureChapter()` already scoped its lookup this way.
        subject: { code: "MATH", grade: { number: 10, board: { code: "CBSE" } } },
      },
    });
    const detail = await chapterDetail(chapter.id);

    expect(detail?.title).toBe("Triangles");
    expect(detail?.topics.length).toBeGreaterThanOrEqual(2);

    const outcomes = detail!.topics.flatMap((topic) => topic.outcomes);
    expect(outcomes.length).toBeGreaterThanOrEqual(5);
    // Every exemplar must pass the check the editor applies. If they do not,
    // the check is wrong.
    for (const item of outcomes) {
      expect(item.quality.ok, `${item.code}: ${item.statement}`).toBe(true);
    }
  });

  it("carries the concept prerequisite edge that root-cause analysis needs", async () => {
    const edges = await prisma.conceptPrerequisite.findMany({
      include: { concept: true, prerequisite: true },
    });
    const edge = edges.find(
      (e) => e.concept.slug === "proportionality-in-triangles",
    );
    expect(edge?.prerequisite.slug).toBe("similarity-of-triangles");
  });

  it("reports chapters that still need outcomes", async () => {
    const overview = await curriculumOverview();
    const maths10 = overview
      .find((board) => board.code === "CBSE")
      ?.grades.find((grade) => grade.number === 10)
      ?.subjects.find((subject) => subject.name === "Mathematics");

    expect(maths10?.chapterCount).toBeGreaterThan(0);
    // The count must be honest, not large: it is the size of the remaining
    // authoring work and it is allowed to reach zero, which is the goal.
    // Asserting it stays above zero pinned the SEED rather than the reader,
    // and other suites author outcomes into these chapters — so which subject
    // still has a bare one drifts with what has been run.
    expect(maths10!.chaptersNeedingOutcomes).toBeGreaterThanOrEqual(0);
    expect(maths10!.chaptersNeedingOutcomes).toBeLessThanOrEqual(
      maths10!.chapterCount,
    );

    // What the reader must actually get right: the count agrees with the tree
    // it was computed from, somewhere in the syllabus.
    const everySubject = overview.flatMap((board) =>
      board.grades.flatMap((grade) => grade.subjects),
    );
    const bare = everySubject.reduce(
      (sum, subject) => sum + subject.chaptersNeedingOutcomes,
      0,
    );
    expect(bare).toBeGreaterThan(0);
  });
});

describe("authoring through the platform connection", () => {
  it("adds a topic and an outcome, and reads them back", async () => {
    const topic = await addTopic(actor, chapterId, "A test topic");
    expect(topic).not.toBeNull();

    const created = await addOutcome(actor, topic!.id, outcome);
    expect(created).not.toBeNull();
    expect(created).not.toHaveProperty("conflict");

    const detail = await chapterDetail(chapterId);
    const saved = detail?.topics
      .find((t) => t.id === topic!.id)
      ?.outcomes.find((o) => o.code === "T-1");
    expect(saved?.statement).toBe(outcome.statement);
    expect(saved?.quality.ok).toBe(true);
  });

  it("refuses a duplicate code within one topic", async () => {
    // Codes are how questions point at outcomes, so a duplicate would make a
    // question's grounding ambiguous.
    const topic = await addTopic(actor, chapterId, `Dup ${randomUUID().slice(0, 6)}`);
    await addOutcome(actor, topic!.id, outcome);
    const again = await addOutcome(actor, topic!.id, outcome);
    expect(again).toHaveProperty("conflict");
  });

  it("allows the same code in a different topic", async () => {
    const other = await addTopic(actor, chapterId, `Other ${randomUUID().slice(0, 6)}`);
    const created = await addOutcome(actor, other!.id, outcome);
    expect(created).not.toHaveProperty("conflict");
  });

  it("saves a weak statement but records the warning", async () => {
    // The check warns, it does not block — an author may know better than a
    // heuristic. What must not happen is the warning being silently dropped.
    const topic = await addTopic(actor, chapterId, `Weak ${randomUUID().slice(0, 6)}`);
    await addOutcome(actor, topic!.id, {
      ...outcome,
      code: "WEAK-1",
      statement: "The chapter covers triangles and their many properties here.",
    });

    const detail = await chapterDetail(chapterId);
    const saved = detail?.topics
      .find((t) => t.id === topic!.id)
      ?.outcomes.find((o) => o.code === "WEAK-1");
    expect(saved).toBeTruthy();
    expect(saved?.quality.ok).toBe(false);
  });

  it("renames a topic", async () => {
    const topic = await addTopic(actor, chapterId, "Before rename");
    expect(await renameTopic(actor, topic!.id, "After rename")).toBe(true);
    const detail = await chapterDetail(chapterId);
    expect(detail?.topics.some((t) => t.title === "After rename")).toBe(true);
  });

  it("updates and deletes an outcome", async () => {
    const topic = await addTopic(actor, chapterId, `Edit ${randomUUID().slice(0, 6)}`);
    const created = await addOutcome(actor, topic!.id, outcome);
    if (!created || !("id" in created)) throw new Error("expected an outcome");

    expect(
      await updateOutcome(actor, created.id, {
        ...outcome,
        statement:
          "Derives the cosine rule and uses it to find an unknown angle of a triangle.",
      }),
    ).toBe(true);

    expect(await deleteOutcome(actor, created.id)).toBe(true);
    expect(await deleteOutcome(actor, created.id)).toBe(false);
  });

  it("deleting a topic reports how many outcomes went with it", async () => {
    const topic = await addTopic(actor, chapterId, `Doomed ${randomUUID().slice(0, 6)}`);
    await addOutcome(actor, topic!.id, { ...outcome, code: "D-1" });
    await addOutcome(actor, topic!.id, { ...outcome, code: "D-2" });

    const result = await deleteTopic(actor, topic!.id);
    expect(result).toEqual({ deleted: true, outcomesRemoved: 2 });
  });

  it("returns null rather than throwing for a chapter that does not exist", async () => {
    expect(await addTopic(actor, randomUUID(), "Nowhere")).toBeNull();
    expect(await chapterDetail(randomUUID())).toBeNull();
  });

  it("audits every curriculum change as a platform action", async () => {
    const topic = await addTopic(actor, chapterId, `Audit ${randomUUID().slice(0, 6)}`);
    const entries = await withTenant(actor.organizationId, (tx) =>
      tx.auditLog.findMany({
        where: { action: "curriculum.topic_added", entityId: topic!.id },
      }),
    );
    expect(entries).toHaveLength(1);
    // Recorded as PLATFORM_ADMIN so a curriculum change is never mistaken for
    // something a teacher did inside their own tenant.
    expect(entries[0]?.actorRole).toBe("PLATFORM_ADMIN");
  });

  it("counts chapters for a subject", async () => {
    const subject = await prisma.subject.findFirstOrThrow({
      // CBSE's Class 10 Maths, named by board. Without it this asked for
      // "Maths in class 10", which is one row per board, and it had started
      // returning ICSE's — 0 chapters against the 14 asserted below. It read
      // exactly like a broken seed and was a test naming a row that is not
      // unique.
      where: { code: "MATH", grade: { number: 10, board: { code: "CBSE" } } },
    });
    // Fixture chapters live in this subject while a run is going — every suite
    // that authors curriculum puts its own chapter here — so count the real ones.
    const chapters = (await chaptersForSubject(subject.id)).filter(
      (chapter) => chapter.number < FIXTURE_CHAPTER_FLOOR,
    );
    expect(chapters.length).toBe(14);
    expect(chapters[0]?.title).toBe("Real Numbers");
  });
});
