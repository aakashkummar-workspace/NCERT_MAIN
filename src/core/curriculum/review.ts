import "server-only";
import { platformPrisma } from "@/db/platform";
import { writeAudit } from "@/core/identity/audit";
import { libraryConfig } from "@/core/library";

/**
 * Review of the imported curriculum drafts — platform only.
 *
 * ---------------------------------------------------------------------------
 * What is being reviewed, and why each is its own stamp
 * ---------------------------------------------------------------------------
 * The NCERT import produced three kinds of judgement, and a subject teacher has
 * to check all three before a school's mastery figures mean anything:
 *
 *   - an OUTCOME — is this what the chapter actually asks a student to do;
 *   - a CONCEPT — do these outcomes really share one idea, and are its
 *     prerequisites right;
 *   - a TAG — does this question really test that outcome. A question can be
 *     worded perfectly and filed under the wrong outcome, and the tag is what
 *     routes its evidence to a concept.
 *
 * Each carries `reviewed_at`, null until a reviewer approves it, and any edit
 * clears it — the approval was given to the previous wording, the same rule as
 * an approved question becoming a new draft version when edited.
 *
 * There is no "approve all". A reviewer who can approve forty outcomes with one
 * press approves forty outcomes without reading them, and a review nobody read
 * is a stamp that says something untrue.
 *
 * ---------------------------------------------------------------------------
 * Tags are reviewed on the LIBRARY'S questions
 * ---------------------------------------------------------------------------
 * The source organization's own questions (QUESTION_LIBRARY_SOURCE), not the
 * copies in every school. Correcting a tag here fixes the library; schools
 * already synced keep the tag they were given, which is the documented cost of
 * copying rather than sharing.
 */

export type Actor = { organizationId: string; userId: string };

async function librarySourceId(): Promise<string | null> {
  const config = libraryConfig();
  if (!config.enabled) return null;
  const org = await platformPrisma.organization.findUnique({
    where: { slug: config.sourceSlug },
    select: { id: true },
  });
  return org?.id ?? null;
}

/** Library questions: the source's own, stamped with a provenance, not deleted or archived. */
function libraryQuestionWhere(sourceId: string) {
  return {
    organizationId: sourceId,
    deletedAt: null,
    libraryOriginId: null,
    provenance: { not: null },
    status: { not: "ARCHIVED" as const },
  };
}

export type ReviewCounts = { total: number; reviewed: number };

export type SubjectReview = {
  id: string;
  gradeLabel: string;
  name: string;
  outcomes: ReviewCounts;
  concepts: ReviewCounts;
  tags: ReviewCounts;
};

/** Every CBSE subject that has something to review, with how far review has got. */
export async function reviewOverview(): Promise<{
  subjects: SubjectReview[];
  librarySource: boolean;
}> {
  const sourceId = await librarySourceId();
  const subjects = await platformPrisma.subject.findMany({
    where: { grade: { board: { code: "CBSE" } }, NOT: { code: { startsWith: "ZZ" } } },
    include: { grade: true },
    orderBy: [{ grade: { number: "asc" } }, { sortOrder: "asc" }],
  });

  const rows: SubjectReview[] = [];
  for (const subject of subjects) {
    const outcomeWhere = { topic: { chapter: { subjectId: subject.id, number: { lt: 1000 } } } };
    const [outcomesTotal, outcomesReviewed, concepts, tagsTotal, tagsReviewed] = await Promise.all([
      platformPrisma.learningOutcome.count({ where: outcomeWhere }),
      platformPrisma.learningOutcome.count({ where: { ...outcomeWhere, reviewedAt: { not: null } } }),
      platformPrisma.concept.findMany({
        where: { outcomes: { some: { outcome: outcomeWhere } } },
        select: { reviewedAt: true },
      }),
      sourceId
        ? platformPrisma.question.count({
            where: { ...libraryQuestionWhere(sourceId), subjectId: subject.id, outcomes: { some: {} } },
          })
        : Promise.resolve(0),
      sourceId
        ? platformPrisma.question.count({
            where: {
              ...libraryQuestionWhere(sourceId),
              subjectId: subject.id,
              outcomes: { some: {} },
              tagReviewedAt: { not: null },
            },
          })
        : Promise.resolve(0),
    ]);
    if (outcomesTotal === 0 && tagsTotal === 0) continue;
    rows.push({
      id: subject.id,
      gradeLabel: subject.grade.label,
      name: subject.name,
      outcomes: { total: outcomesTotal, reviewed: outcomesReviewed },
      concepts: { total: concepts.length, reviewed: concepts.filter((c) => c.reviewedAt).length },
      tags: { total: tagsTotal, reviewed: tagsReviewed },
    });
  }
  return { subjects: rows, librarySource: sourceId !== null };
}

export type ChapterReviewRow = {
  id: string;
  number: number;
  title: string;
  outcomes: ReviewCounts;
  tags: ReviewCounts;
};

/** One subject's chapters, each with its outstanding review. */
export async function subjectReview(subjectId: string) {
  const subject = await platformPrisma.subject.findUnique({
    where: { id: subjectId },
    include: { grade: true, chapters: { where: { number: { lt: 1000 } }, orderBy: { number: "asc" } } },
  });
  if (!subject) return null;
  const sourceId = await librarySourceId();

  const chapters: ChapterReviewRow[] = [];
  for (const chapter of subject.chapters) {
    const outcomeWhere = { topic: { chapterId: chapter.id } };
    const tagWhere = sourceId
      ? { ...libraryQuestionWhere(sourceId), chapterId: chapter.id, outcomes: { some: {} } }
      : null;
    const [oTotal, oReviewed, tTotal, tReviewed] = await Promise.all([
      platformPrisma.learningOutcome.count({ where: outcomeWhere }),
      platformPrisma.learningOutcome.count({ where: { ...outcomeWhere, reviewedAt: { not: null } } }),
      tagWhere ? platformPrisma.question.count({ where: tagWhere }) : Promise.resolve(0),
      tagWhere
        ? platformPrisma.question.count({ where: { ...tagWhere, tagReviewedAt: { not: null } } })
        : Promise.resolve(0),
    ]);
    chapters.push({
      id: chapter.id,
      number: chapter.number,
      title: chapter.title,
      outcomes: { total: oTotal, reviewed: oReviewed },
      tags: { total: tTotal, reviewed: tReviewed },
    });
  }
  return { id: subject.id, name: subject.name, gradeLabel: subject.grade.label, chapters };
}

export type ReviewOutcome = {
  id: string;
  code: string;
  statement: string;
  bloomLevel: string;
  topicTitle: string;
  reviewedAt: Date | null;
};

export type ReviewConcept = {
  id: string;
  name: string;
  description: string | null;
  outcomeCodes: string[];
  requires: string[];
  reviewedAt: Date | null;
};

export type ReviewQuestion = {
  id: string;
  stem: string;
  options: { key: string; text: string; isCorrect: boolean }[];
  explanation: string | null;
  difficulty: string;
  provenance: string | null;
  outcomeId: string | null;
  tagReviewedAt: Date | null;
};

/** Everything a reviewer reads for one chapter. */
export async function chapterReview(chapterId: string) {
  const chapter = await platformPrisma.chapter.findUnique({
    where: { id: chapterId },
    include: {
      subject: { include: { grade: true } },
      topics: {
        orderBy: { sortOrder: "asc" },
        include: { outcomes: { orderBy: { sortOrder: "asc" } } },
      },
    },
  });
  if (!chapter) return null;

  const outcomes: ReviewOutcome[] = chapter.topics.flatMap((topic) =>
    topic.outcomes.map((o) => ({
      id: o.id,
      code: o.code,
      statement: o.statement,
      bloomLevel: o.bloomLevel,
      topicTitle: topic.title,
      reviewedAt: o.reviewedAt,
    })),
  );
  const outcomeIds = outcomes.map((o) => o.id);
  const codeById = new Map(outcomes.map((o) => [o.id, o.code]));

  const conceptRows = await platformPrisma.concept.findMany({
    where: { outcomes: { some: { learningOutcomeId: { in: outcomeIds } } } },
    include: {
      outcomes: { select: { learningOutcomeId: true } },
      prerequisites: { include: { prerequisite: { select: { name: true } } } },
    },
    orderBy: { name: "asc" },
  });
  const concepts: ReviewConcept[] = conceptRows.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    outcomeCodes: c.outcomes
      .map((o) => codeById.get(o.learningOutcomeId) ?? "another chapter")
      .sort(),
    requires: c.prerequisites.map((p) => p.prerequisite.name).sort(),
    reviewedAt: c.reviewedAt,
  }));

  const sourceId = await librarySourceId();
  const questionRows = sourceId
    ? await platformPrisma.question.findMany({
        where: { ...libraryQuestionWhere(sourceId), chapterId },
        include: {
          versions: { orderBy: { version: "desc" }, take: 1 },
          outcomes: true,
        },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const questions: ReviewQuestion[] = questionRows.map((q) => {
    const current = q.versions[0];
    const options = Array.isArray(current?.options)
      ? (current.options as { key: string; text: string; isCorrect: boolean }[])
      : [];
    const primary = q.outcomes.find((o) => o.isPrimary) ?? q.outcomes[0];
    return {
      id: q.id,
      stem: current?.stem ?? "",
      options,
      explanation: current?.explanation ?? null,
      difficulty: q.difficulty,
      provenance: q.provenance,
      outcomeId: primary?.learningOutcomeId ?? null,
      tagReviewedAt: q.tagReviewedAt,
    };
  });

  return {
    id: chapter.id,
    number: chapter.number,
    title: chapter.title,
    subjectId: chapter.subjectId,
    subjectName: chapter.subject.name,
    gradeLabel: chapter.subject.grade.label,
    outcomes,
    concepts,
    questions,
    librarySource: sourceId !== null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function audit(actor: Actor, action: string, entityType: string, entityId: string, after: unknown) {
  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: "PLATFORM_ADMIN",
    action,
    entityType,
    entityId,
    after,
  });
}

export async function approveOutcome(actor: Actor, outcomeId: string): Promise<boolean> {
  const outcome = await platformPrisma.learningOutcome.findUnique({ where: { id: outcomeId } });
  if (!outcome) return false;
  await platformPrisma.learningOutcome.update({
    where: { id: outcomeId },
    data: { reviewedAt: new Date(), reviewedById: actor.userId },
  });
  await audit(actor, "curriculum.outcome_reviewed", "learning_outcome", outcomeId, {
    code: outcome.code,
    statement: outcome.statement,
  });
  return true;
}

export async function approveConcept(actor: Actor, conceptId: string): Promise<boolean> {
  const concept = await platformPrisma.concept.findUnique({ where: { id: conceptId } });
  if (!concept) return false;
  await platformPrisma.concept.update({
    where: { id: conceptId },
    data: { reviewedAt: new Date(), reviewedById: actor.userId },
  });
  await audit(actor, "curriculum.concept_reviewed", "concept", conceptId, { name: concept.name });
  return true;
}

export type TagResult =
  | { ok: true; changed: boolean }
  | { ok: false; message: string };

/**
 * Confirm a question's tag, or move it to another outcome and confirm that.
 *
 * The outcome must belong to the question's OWN chapter — the same rule the
 * tagging script and the question validator enforce, because an outcome from
 * another chapter attributes the evidence to the wrong syllabus forever.
 */
export async function confirmTag(actor: Actor, questionId: string, outcomeId: string): Promise<TagResult> {
  const sourceId = await librarySourceId();
  if (!sourceId) return { ok: false, message: "No question library is configured." };

  const question = await platformPrisma.question.findFirst({
    where: { ...libraryQuestionWhere(sourceId), id: questionId },
    include: { outcomes: true },
  });
  if (!question) return { ok: false, message: "That is not a question in the library." };

  const outcome = await platformPrisma.learningOutcome.findUnique({
    where: { id: outcomeId },
    include: { topic: true },
  });
  if (!outcome || outcome.topic.chapterId !== question.chapterId) {
    return { ok: false, message: "That outcome is not in this question's chapter." };
  }

  const previous = question.outcomes.find((o) => o.isPrimary) ?? question.outcomes[0];
  const changed = previous?.learningOutcomeId !== outcomeId;

  await platformPrisma.$transaction(async (tx) => {
    if (changed) {
      await tx.questionOutcome.deleteMany({ where: { questionId } });
      await tx.questionOutcome.create({
        data: { questionId, learningOutcomeId: outcomeId, weight: 1, isPrimary: true },
      });
    }
    await tx.question.update({
      where: { id: questionId },
      data: {
        primaryOutcomeId: outcomeId,
        tagReviewedAt: new Date(),
        tagReviewedById: actor.userId,
      },
    });
  });

  await audit(actor, changed ? "question.tag_changed" : "question.tag_reviewed", "question", questionId, {
    outcomeCode: outcome.code,
    previousOutcomeId: previous?.learningOutcomeId ?? null,
  });
  return { ok: true, changed };
}
