import "server-only";
import { randomUUID } from "node:crypto";
import { platformPrisma } from "@/db/platform";
import { writeAudit } from "@/core/identity/audit";
import { checkOutcomeStatement } from "./outcome-quality";

/**
 * Curriculum authoring — platform only.
 *
 * Every function here writes the shared curriculum plane, which every tenant
 * reads. A mistake here is a mistake in every customer's product at once, so
 * two things are true of all of them:
 *
 *   1. They run on the platform connection, whose role is the only one the
 *      curriculum write policies are scoped to. A teacher-facing route holds a
 *      connection with no grant on these tables at all.
 *   2. They are audited, because a cross-tenant action that nobody can
 *      reconstruct is a cross-tenant action nobody can defend.
 */

// ---------------------------------------------------------------------------
// Reads (the platform view, including the counts that drive the editor)
// ---------------------------------------------------------------------------

/**
 * The whole tree, grouped by BOARD.
 *
 * The platform console is the one surface that is not board-scoped, and it has
 * to be: authoring is our own work, done once for every school. Grouped rather
 * than flat because two boards both have a "Class 9" and a "Mathematics", and
 * a flat list of eight identical-looking cards is a console nobody can use —
 * the same reason the concept list is grouped by subject.
 */
export async function curriculumOverview() {
  const boards = await platformPrisma.board.findMany({
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  const grades = await platformPrisma.grade.findMany({
    include: {
      subjects: {
        orderBy: { sortOrder: "asc" },
        include: {
          _count: { select: { chapters: true } },
          chapters: {
            orderBy: { number: "asc" },
            include: { _count: { select: { topics: true } } },
          },
        },
      },
    },
    orderBy: { number: "asc" },
  });

  const shape = (grade: (typeof grades)[number]) => ({
    id: grade.id,
    number: grade.number,
    label: grade.label,
    subjects: grade.subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      shortName: subject.shortName,
      chapterCount: subject._count.chapters,
      // The number that matters: a chapter with no outcomes cannot ground a
      // generated question, so this is the size of the remaining work.
      chaptersNeedingOutcomes: subject.chapters.filter(
        (chapter) => chapter._count.topics === 0,
      ).length,
    })),
  });

  return boards.map((board) => ({
    id: board.id,
    code: board.code,
    name: board.name,
    // A board with no grades is listed rather than hidden. "ICSE, nothing
    // authored" is the state this product is actually in, and a console that
    // showed only what exists would make the work invisible.
    grades: grades.filter((grade) => grade.boardId === board.id).map(shape),
  }));
}

/**
 * What the public landing page may say about the syllabus.
 *
 * The page used to hard-code its chapter lists, and they had drifted: Class 9
 * showed the OLD NCERT books the product no longer uses, and every outcome
 * count was invented. So it reads the curriculum plane instead, and can only
 * claim what is in it — including the fact that the outcomes are drafts
 * nobody has reviewed yet.
 *
 * CBSE Mathematics and Science for Class 9 and 10, the subjects the page is
 * about. Fixture chapters (numbered 1000 and up, authored by test runs) are
 * excluded, because a visitor must never see "Smoke chapter 1004".
 */
export type PublicChapter = {
  number: number;
  title: string;
  outcomes: number;
  reviewedOutcomes: number;
  concepts: string[];
};

export type PublicSubject = {
  grade: number;
  code: string;
  name: string;
  chapters: PublicChapter[];
};

const PUBLIC_SUBJECTS = ["MATH", "SCI"];
const FIXTURE_CHAPTER_FLOOR = 1000;

export async function publicCurriculum(): Promise<PublicSubject[]> {
  const subjects = await platformPrisma.subject.findMany({
    where: {
      code: { in: PUBLIC_SUBJECTS },
      grade: { number: { in: [9, 10] }, board: { code: "CBSE" } },
    },
    orderBy: { sortOrder: "asc" },
    select: {
      code: true,
      name: true,
      grade: { select: { number: true } },
      chapters: {
        where: { number: { lt: FIXTURE_CHAPTER_FLOOR } },
        orderBy: { number: "asc" },
        select: {
          number: true,
          title: true,
          topics: {
            select: {
              outcomes: {
                select: {
                  reviewedAt: true,
                  concepts: { select: { concept: { select: { name: true } } } },
                },
              },
            },
          },
        },
      },
    },
  });

  return subjects.map((subject) => ({
    grade: subject.grade.number,
    code: subject.code,
    name: subject.name,
    chapters: subject.chapters.map((chapter) => {
      const outcomes = chapter.topics.flatMap((topic) => topic.outcomes);
      const concepts = [
        ...new Set(
          outcomes.flatMap((outcome) => outcome.concepts.map((link) => link.concept.name)),
        ),
      ];
      return {
        number: chapter.number,
        title: chapter.title,
        outcomes: outcomes.length,
        reviewedOutcomes: outcomes.filter((outcome) => outcome.reviewedAt !== null).length,
        concepts: concepts.slice(0, 4),
      };
    }),
  }));
}

export async function chaptersForSubject(subjectId: string) {
  if (!isUuid(subjectId)) return [];
  const chapters = await platformPrisma.chapter.findMany({
    where: { subjectId },
    orderBy: { number: "asc" },
    include: { topics: { include: { _count: { select: { outcomes: true } } } } },
  });

  return chapters.map((chapter) => ({
    id: chapter.id,
    number: chapter.number,
    title: chapter.title,
    topicCount: chapter.topics.length,
    outcomeCount: chapter.topics.reduce(
      (sum, topic) => sum + topic._count.outcomes,
      0,
    ),
  }));
}

export async function subjectHeading(subjectId: string) {
  if (!isUuid(subjectId)) return null;
  const subject = await platformPrisma.subject.findUnique({
    where: { id: subjectId },
    include: { grade: true },
  });
  if (!subject) return null;
  return {
    id: subject.id,
    name: subject.name,
    gradeLabel: subject.grade.label,
  };
}

export async function chapterDetail(chapterId: string) {
  if (!isUuid(chapterId)) return null;
  const chapter = await platformPrisma.chapter.findUnique({
    where: { id: chapterId },
    include: {
      subject: { include: { grade: true } },
      topics: {
        orderBy: { sortOrder: "asc" },
        include: {
          outcomes: {
            orderBy: { sortOrder: "asc" },
            include: { concepts: { include: { concept: true } } },
          },
        },
      },
    },
  });
  if (!chapter) return null;

  return {
    id: chapter.id,
    number: chapter.number,
    title: chapter.title,
    source: chapter.source,
    subjectId: chapter.subjectId,
    subjectName: chapter.subject.name,
    gradeLabel: chapter.subject.grade.label,
    topics: chapter.topics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      outcomes: topic.outcomes.map((outcome) => ({
        id: outcome.id,
        code: outcome.code,
        statement: outcome.statement,
        bloomLevel: outcome.bloomLevel,
        competency: outcome.competency,
        typicalMarks: outcome.typicalMarks,
        concepts: outcome.concepts.map((link) => ({
          id: link.concept.id,
          name: link.concept.name,
        })),
        quality: checkOutcomeStatement(outcome.statement),
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

type Actor = { userId: string; organizationId: string };

export async function addTopic(
  actor: Actor,
  chapterId: string,
  title: string,
): Promise<{ id: string } | null> {
  if (!isUuid(chapterId)) return null;
  const chapter = await platformPrisma.chapter.findUnique({
    where: { id: chapterId },
  });
  if (!chapter) return null;

  const count = await platformPrisma.topic.count({ where: { chapterId } });
  const topic = await platformPrisma.topic.create({
    data: { id: randomUUID(), chapterId, title: title.trim(), sortOrder: count },
  });

  await auditPlatform(actor, "curriculum.topic_added", "topic", topic.id, {
    chapterId,
    title,
  });
  return { id: topic.id };
}

export async function renameTopic(
  actor: Actor,
  topicId: string,
  title: string,
): Promise<boolean> {
  if (!isUuid(topicId)) return false;
  const before = await platformPrisma.topic.findUnique({ where: { id: topicId } });
  if (!before) return false;

  await platformPrisma.topic.update({
    where: { id: topicId },
    data: { title: title.trim() },
  });

  await auditPlatform(
    actor,
    "curriculum.topic_renamed",
    "topic",
    topicId,
    { title },
    { title: before.title },
  );
  return true;
}

export async function deleteTopic(
  actor: Actor,
  topicId: string,
): Promise<{ deleted: boolean; outcomesRemoved: number }> {
  if (!isUuid(topicId)) return { deleted: false, outcomesRemoved: 0 };
  const topic = await platformPrisma.topic.findUnique({
    where: { id: topicId },
    include: { _count: { select: { outcomes: true } } },
  });
  if (!topic) return { deleted: false, outcomesRemoved: 0 };

  await platformPrisma.topic.delete({ where: { id: topicId } });

  await auditPlatform(actor, "curriculum.topic_deleted", "topic", topicId, null, {
    title: topic.title,
    outcomes: topic._count.outcomes,
  });
  return { deleted: true, outcomesRemoved: topic._count.outcomes };
}

export type OutcomeInput = {
  code: string;
  statement: string;
  bloomLevel:
    | "REMEMBER"
    | "UNDERSTAND"
    | "APPLY"
    | "ANALYSE"
    | "EVALUATE"
    | "CREATE";
  competency:
    | "KNOWLEDGE"
    | "UNDERSTANDING"
    | "APPLICATION"
    | "PROBLEM_SOLVING"
    | "ANALYSIS"
    | "EVALUATION";
  typicalMarks: number;
};

export async function addOutcome(
  actor: Actor,
  topicId: string,
  input: OutcomeInput,
): Promise<{ id: string } | { conflict: true } | null> {
  if (!isUuid(topicId)) return null;
  const topic = await platformPrisma.topic.findUnique({ where: { id: topicId } });
  if (!topic) return null;

  const existing = await platformPrisma.learningOutcome.findFirst({
    where: { topicId, code: input.code.trim() },
  });
  if (existing) return { conflict: true };

  const count = await platformPrisma.learningOutcome.count({ where: { topicId } });
  const outcome = await platformPrisma.learningOutcome.create({
    data: {
      id: randomUUID(),
      topicId,
      code: input.code.trim(),
      statement: input.statement.trim(),
      bloomLevel: input.bloomLevel,
      competency: input.competency,
      typicalMarks: input.typicalMarks,
      sortOrder: count,
    },
  });

  await auditPlatform(
    actor,
    "curriculum.outcome_added",
    "learning_outcome",
    outcome.id,
    { topicId, code: input.code, statement: input.statement },
  );
  return { id: outcome.id };
}

export async function updateOutcome(
  actor: Actor,
  outcomeId: string,
  input: OutcomeInput,
): Promise<boolean> {
  if (!isUuid(outcomeId)) return false;
  const before = await platformPrisma.learningOutcome.findUnique({
    where: { id: outcomeId },
  });
  if (!before) return false;

  await platformPrisma.learningOutcome.update({
    where: { id: outcomeId },
    data: {
      code: input.code.trim(),
      statement: input.statement.trim(),
      bloomLevel: input.bloomLevel,
      competency: input.competency,
      typicalMarks: input.typicalMarks,
      // The review was given to the previous wording.
      reviewedAt: null,
      reviewedById: null,
    },
  });

  await auditPlatform(
    actor,
    "curriculum.outcome_updated",
    "learning_outcome",
    outcomeId,
    { code: input.code, statement: input.statement },
    { code: before.code, statement: before.statement },
  );
  return true;
}

export async function deleteOutcome(
  actor: Actor,
  outcomeId: string,
): Promise<boolean> {
  if (!isUuid(outcomeId)) return false;
  const before = await platformPrisma.learningOutcome.findUnique({
    where: { id: outcomeId },
  });
  if (!before) return false;

  await platformPrisma.learningOutcome.delete({ where: { id: outcomeId } });

  await auditPlatform(
    actor,
    "curriculum.outcome_deleted",
    "learning_outcome",
    outcomeId,
    null,
    { code: before.code, statement: before.statement },
  );
  return true;
}

// ---------------------------------------------------------------------------

/**
 * Audited against the actor's own organization, with the role recorded as
 * PLATFORM_ADMIN so a curriculum change is never mistaken for something a
 * teacher did inside their own tenant.
 */
async function auditPlatform(
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  after?: unknown,
  before?: unknown,
) {
  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: "PLATFORM_ADMIN",
    action,
    entityType,
    entityId,
    before,
    after,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed id names no row. Answered as "not found" here rather than
 * reaching Postgres, which rejects it as an invalid uuid and turns a mistyped
 * URL into a 500.
 */
function isUuid(value: string): boolean {
  return UUID.test(value);
}
