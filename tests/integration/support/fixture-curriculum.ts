import { randomUUID } from "node:crypto";
import { platformPrisma } from "@/db/platform";
import { fixtureChapterNumber } from "../../../scripts/lib/fixture-curriculum.mjs";

/**
 * A chapter this suite owns, for any curriculum it needs to author.
 *
 * Topics and outcomes a test writes go HERE and nowhere else — never into a
 * seeded chapter, where they become part of the syllabus every school sees.
 * The chapter number is the fixture marker, and the integration global
 * teardown removes every fixture chapter (and the run's concepts left
 * measuring nothing) after the run.
 *
 * `subjectId` defaults to CBSE Class 10 Mathematics — the subject `makeWorld`
 * builds on — because a question, its paper and its class must share a subject.
 * Written on the platform connection: the app role has no insert grant on the
 * curriculum plane at all.
 */
export async function fixtureChapter(
  options: { subjectId?: string; label?: string; topics?: number } = {},
) {
  const subjectId =
    options.subjectId ??
    (
      await platformPrisma.subject.findFirstOrThrow({
        where: { code: "MATH", grade: { number: 10, board: { code: "CBSE" } } },
        select: { id: true },
      })
    ).id;
  const number = fixtureChapterNumber();
  const label = options.label ?? "Fixture";
  const chapter = await platformPrisma.chapter.create({
    data: {
      subjectId,
      number,
      title: `${label} chapter ${number}`,
      source: "integration test fixture — removed by the global teardown",
      topics: {
        create: Array.from({ length: options.topics ?? 1 }, (_, index) => ({
          title: `${label} topic ${index + 1}`,
          sortOrder: index,
        })),
      },
    },
    include: { topics: { orderBy: { sortOrder: "asc" } } },
  });
  return {
    subjectId,
    chapterId: chapter.id,
    topicId: chapter.topics[0]?.id ?? "",
    topicIds: chapter.topics.map((t) => t.id),
  };
}

/** An uncovered outcome in a fixture topic. */
export function fixtureOutcome(topicId: string, prefix = "FIX") {
  const suffix = randomUUID().slice(0, 8);
  return platformPrisma.learningOutcome.create({
    data: {
      topicId,
      code: `${prefix}-${suffix}`,
      statement: `Apply the ${suffix} idea to a worked problem.`,
      bloomLevel: "APPLY",
    },
  });
}
