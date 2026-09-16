import "server-only";
import { randomUUID } from "node:crypto";
import { platformPrisma } from "@/db/platform";
import { writeAudit } from "@/core/identity/audit";
import {
  checkConceptName,
  checkWeight,
  chainDepth,
  uniqueConceptSlug,
  wouldCycle,
  DEEP_CHAIN,
  type PrerequisiteEdge,
  type Problem,
} from "./concept-rules";

/**
 * Concept authoring — platform only.
 *
 * ---------------------------------------------------------------------------
 * Why this is the most consequential authoring surface in the product
 * ---------------------------------------------------------------------------
 * A concept has no `organization_id`. Every tenant reads the same row, and
 * every mastery estimate, learning gap, practice recommendation, study plan and
 * term report is keyed on one. Editing a concept edits every customer's product
 * at once — which is exactly the cross-tenant intelligence the two-plane split
 * exists to make possible, and exactly why every function here is audited and
 * runs on the platform connection.
 *
 * Until this file existed, concepts could only be SEEDED. The console could
 * describe a syllabus down to the outcome and still not make any of it
 * measurable, which is why the shipped curriculum has two concepts covering
 * five outcomes and why a term report cannot be written for a real school.
 *
 * ---------------------------------------------------------------------------
 * There is no delete, and the reason is structural
 * ---------------------------------------------------------------------------
 * `concept_evidence.concept_id` and `student_concept_mastery.concept_id` are
 * plain uuid columns with NO foreign key to `concepts` — deliberately, because
 * a cross-plane constraint would couple the tenant tables to the shared one.
 *
 * So the database will not stop a delete. It would succeed, silently, and leave
 * every estimate derived through that concept pointing at nothing: the analytics
 * grid loses a column heading, a term report written in September becomes
 * unexplainable, and `rebuildMastery` cannot re-derive what the row meant. The
 * append-only ledger's whole promise is that a past estimate stays
 * re-derivable, and deleting the concept it was about breaks that promise
 * quietly.
 *
 * A concept that turns out to be wrong is renamed, or has its outcome links
 * removed — which stops it accruing new evidence while leaving what it already
 * measured explainable. Retiring, not deleting. Same discipline as a gap that
 * closes only on evidence and a report that supersedes rather than being
 * edited.
 */

export type Actor = { organizationId: string; userId: string };

export type ConceptRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** How many learning outcomes this concept is measured through. */
  outcomeCount: number;
  /** Which subjects those outcomes belong to. */
  subjects: string[];
  prerequisiteCount: number;
};

export async function listConcepts(): Promise<ConceptRow[]> {
  const concepts = await platformPrisma.concept.findMany({
    include: {
      outcomes: {
        include: {
          outcome: {
            include: { topic: { include: { chapter: { include: { subject: true } } } } },
          },
        },
      },
      prerequisites: true,
    },
    orderBy: { name: "asc" },
  });

  return concepts.map((concept) => ({
    id: concept.id,
    slug: concept.slug,
    name: concept.name,
    description: concept.description,
    outcomeCount: concept.outcomes.length,
    subjects: [
      ...new Set(
        concept.outcomes.map((link) => link.outcome.topic.chapter.subject.name),
      ),
    ].sort(),
    prerequisiteCount: concept.prerequisites.length,
  }));
}

export type ConceptDetail = ConceptRow & {
  outcomes: {
    id: string;
    code: string;
    statement: string;
    weight: number;
    subjectName: string;
    chapterTitle: string;
  }[];
  prerequisites: { id: string; name: string; strength: number }[];
  /** Concepts that list THIS one as a prerequisite. Deleting is not the only
   *  way to break somebody: unlinking an outcome one of these depends on is. */
  requiredBy: { id: string; name: string }[];
  /** A chain this deep lands root-cause analysis on Class 6 arithmetic. */
  chainWarning: boolean;
};

export async function conceptDetail(id: string): Promise<ConceptDetail | null> {
  if (!isUuid(id)) return null;
  const concept = await platformPrisma.concept.findUnique({
    where: { id },
    include: {
      outcomes: {
        include: {
          outcome: {
            include: { topic: { include: { chapter: { include: { subject: true } } } } },
          },
        },
      },
      prerequisites: { include: { prerequisite: true } },
      requiredBy: { include: { concept: true } },
    },
  });
  if (!concept) return null;

  const edges = await allEdges();

  return {
    id: concept.id,
    slug: concept.slug,
    name: concept.name,
    description: concept.description,
    outcomeCount: concept.outcomes.length,
    subjects: [
      ...new Set(
        concept.outcomes.map((link) => link.outcome.topic.chapter.subject.name),
      ),
    ].sort(),
    prerequisiteCount: concept.prerequisites.length,
    outcomes: concept.outcomes
      .map((link) => ({
        id: link.outcome.id,
        code: link.outcome.code,
        statement: link.outcome.statement,
        weight: Number(link.weight),
        subjectName: link.outcome.topic.chapter.subject.name,
        chapterTitle: link.outcome.topic.chapter.title,
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    prerequisites: concept.prerequisites
      .map((link) => ({
        id: link.prerequisite.id,
        name: link.prerequisite.name,
        strength: Number(link.strength),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    requiredBy: concept.requiredBy
      .map((link) => ({ id: link.concept.id, name: link.concept.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    chainWarning: chainDepth(edges, id) > DEEP_CHAIN,
  };
}

/**
 * Outcomes nothing measures.
 *
 * The authoring worklist, and the single most useful thing on the page: an
 * outcome no concept covers can be tested, scored and released, and will never
 * inform a mastery figure — so the product looks like it is working while the
 * intelligent half of it quietly has nothing to say. `conceptCoverage()` puts
 * the number on the console; this puts the actual rows in front of the person
 * who can fix them.
 */
export type UncoveredOutcome = {
  /** The id, so a picker filters by the subject rather than its NAME — two
   *  boards both have a "Mathematics". */
  subjectId: string;
  id: string;
  code: string;
  statement: string;
  subjectName: string;
  gradeLabel: string;
  chapterTitle: string;
};

export async function uncoveredOutcomes(
  subjectId?: string,
  limit = 200,
): Promise<UncoveredOutcome[]> {
  if (subjectId && !isUuid(subjectId)) return [];
  const outcomes = await platformPrisma.learningOutcome.findMany({
    where: {
      concepts: { none: {} },
      ...(subjectId
        ? { topic: { chapter: { subjectId } } }
        : {}),
    },
    include: {
      topic: {
        include: { chapter: { include: { subject: { include: { grade: true } } } } },
      },
    },
    orderBy: [{ topicId: "asc" }, { sortOrder: "asc" }],
    take: limit,
  });

  return outcomes.map((outcome) => ({
    id: outcome.id,
    code: outcome.code,
    statement: outcome.statement,
    subjectId: outcome.topic.chapter.subjectId,
    subjectName: outcome.topic.chapter.subject.name,
    gradeLabel: outcome.topic.chapter.subject.grade.label,
    chapterTitle: outcome.topic.chapter.title,
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type WriteResult<T = { id: string }> =
  | ({ ok: true } & T)
  | { ok: false; problems: Problem[] };

export async function createConcept(
  actor: Actor,
  input: { name: string; description?: string | null },
): Promise<WriteResult> {
  const problems = checkConceptName(input.name).filter((p) => p.severity === "error");
  if (problems.length > 0) return { ok: false, problems };

  const name = input.name.trim();

  const existing = await platformPrisma.concept.findFirst({ where: { name } });
  if (existing) {
    // Refused rather than silently made unique. Two concepts with the same name
    // are indistinguishable on a heatmap column and in a report, and whichever
    // one a question ends up mapped to is a coin toss.
    return {
      ok: false,
      problems: [
        {
          field: "name",
          message: "A concept with this name already exists.",
          severity: "error",
        },
      ],
    };
  }

  const taken = (
    await platformPrisma.concept.findMany({ select: { slug: true } })
  ).map((row) => row.slug);

  const concept = await platformPrisma.concept.create({
    data: {
      id: randomUUID(),
      slug: uniqueConceptSlug(name, taken),
      name,
      description: input.description?.trim() || null,
    },
  });

  await audit(actor, "curriculum.concept_created", concept.id, {
    name,
    slug: concept.slug,
  });
  return { ok: true, id: concept.id };
}

/**
 * Create a concept and link its outcomes in one action.
 *
 * What the review screen presses. Separate from `createConcept` because a
 * concept with no outcomes is the "measures nothing" state the console warns
 * about — and creating one, then failing partway through the links, would
 * manufacture exactly that state from a single click.
 *
 * Not a database transaction, deliberately: `platformPrisma` writes the shared
 * plane and each link is independently audited, so a partial result is
 * recoverable by hand and visible in the log. What matters is that the caller
 * is told how many landed.
 */
export async function createConceptWithOutcomes(
  actor: Actor,
  input: { name: string; description?: string | null; outcomeIds: string[] },
): Promise<
  | { ok: true; id: string; linked: number }
  | { ok: false; problems: Problem[] }
> {
  const created = await createConcept(actor, {
    name: input.name,
    description: input.description,
  });
  if (!created.ok) return created;

  let linked = 0;
  for (const outcomeId of input.outcomeIds) {
    const link = await linkOutcome(actor, created.id, outcomeId, 1);
    if (link.ok) linked++;
  }

  return { ok: true, id: created.id, linked };
}

export async function renameConcept(
  actor: Actor,
  id: string,
  input: { name: string; description?: string | null },
): Promise<WriteResult<{ id: string }>> {
  const problems = checkConceptName(input.name).filter((p) => p.severity === "error");
  if (problems.length > 0) return { ok: false, problems };

  const before = isUuid(id)
    ? await platformPrisma.concept.findUnique({ where: { id } })
    : null;
  if (!before) {
    return {
      ok: false,
      problems: [{ field: "name", message: "No such concept.", severity: "error" }],
    };
  }

  const name = input.name.trim();
  const clash = await platformPrisma.concept.findFirst({
    where: { name, id: { not: id } },
  });
  if (clash) {
    return {
      ok: false,
      problems: [
        {
          field: "name",
          message: "Another concept already has this name.",
          severity: "error",
        },
      ],
    };
  }

  // The SLUG does not follow the name, and that is deliberate. It is an
  // identifier: a seed file, a support ticket and anything anybody has written
  // down refer to it, and an identifier that changes when somebody fixes a
  // typo is an identifier nothing can rely on.
  await platformPrisma.concept.update({
    where: { id },
    data: { name, description: input.description?.trim() || null, reviewedAt: null, reviewedById: null },
  });

  await audit(
    actor,
    "curriculum.concept_updated",
    id,
    { name },
    { name: before.name },
  );
  return { ok: true, id };
}

export async function linkOutcome(
  actor: Actor,
  conceptId: string,
  outcomeId: string,
  weight = 1,
): Promise<WriteResult<{ id: string }>> {
  const problems = checkWeight(weight);
  if (problems.length > 0) return { ok: false, problems };

  const known = isUuid(conceptId) && isUuid(outcomeId);
  const [concept, outcome] = !known ? [null, null] : await Promise.all([
    platformPrisma.concept.findUnique({ where: { id: conceptId } }),
    platformPrisma.learningOutcome.findUnique({ where: { id: outcomeId } }),
  ]);
  if (!concept || !outcome) {
    return {
      ok: false,
      problems: [
        { field: "outcomeId", message: "No such concept or outcome.", severity: "error" },
      ],
    };
  }

  await platformPrisma.conceptOutcome.upsert({
    where: {
      conceptId_learningOutcomeId: { conceptId, learningOutcomeId: outcomeId },
    },
    create: { conceptId, learningOutcomeId: outcomeId, weight },
    update: { weight },
  });
  await unreview(conceptId);

  await audit(actor, "curriculum.concept_outcome_linked", conceptId, {
    outcomeId,
    outcomeCode: outcome.code,
    weight,
  });
  return { ok: true, id: conceptId };
}

/**
 * Stop measuring this concept through this outcome.
 *
 * Past evidence is untouched: `concept_evidence` stores `concept_id` on the row
 * itself, so what was already measured keeps its meaning and every historical
 * estimate stays re-derivable. Only future answers are affected.
 *
 * That is the whole reason unlinking is safe where deleting is not.
 */
export async function unlinkOutcome(
  actor: Actor,
  conceptId: string,
  outcomeId: string,
): Promise<boolean> {
  if (!isUuid(conceptId) || !isUuid(outcomeId)) return false;
  const link = await platformPrisma.conceptOutcome.findUnique({
    where: {
      conceptId_learningOutcomeId: { conceptId, learningOutcomeId: outcomeId },
    },
  });
  if (!link) return false;

  await platformPrisma.conceptOutcome.delete({
    where: {
      conceptId_learningOutcomeId: { conceptId, learningOutcomeId: outcomeId },
    },
  });
  await unreview(conceptId);

  await audit(
    actor,
    "curriculum.concept_outcome_unlinked",
    conceptId,
    null,
    { outcomeId, weight: Number(link.weight) },
  );
  return true;
}

export async function addPrerequisite(
  actor: Actor,
  conceptId: string,
  prerequisiteId: string,
  strength = 1,
): Promise<WriteResult<{ id: string }>> {
  const problems = checkWeight(strength);
  if (problems.length > 0) return { ok: false, problems };

  const known = isUuid(conceptId) && isUuid(prerequisiteId);
  const [concept, prerequisite] = !known ? [null, null] : await Promise.all([
    platformPrisma.concept.findUnique({ where: { id: conceptId } }),
    platformPrisma.concept.findUnique({ where: { id: prerequisiteId } }),
  ]);
  if (!concept || !prerequisite) {
    return {
      ok: false,
      problems: [
        { field: "prerequisiteId", message: "No such concept.", severity: "error" },
      ],
    };
  }

  // The check that has to be right. `prerequisitesOf` is walked to name a root
  // cause, and a cycle makes that unanswerable — every concept ends up the
  // cause of itself, and a teacher is sent round in circles by something that
  // looks like an answer.
  const edges = await allEdges();
  if (wouldCycle(edges, conceptId, prerequisiteId)) {
    return {
      ok: false,
      problems: [
        {
          field: "prerequisiteId",
          message:
            conceptId === prerequisiteId
              ? "A concept cannot be its own prerequisite."
              : "That would make a loop: this concept is already upstream of the one you picked, so each would be the root cause of the other.",
          severity: "error",
        },
      ],
    };
  }

  await platformPrisma.conceptPrerequisite.upsert({
    where: { conceptId_prerequisiteId: { conceptId, prerequisiteId } },
    create: { conceptId, prerequisiteId, strength },
    update: { strength },
  });
  await unreview(conceptId);

  await audit(actor, "curriculum.concept_prerequisite_added", conceptId, {
    prerequisiteId,
    prerequisiteName: prerequisite.name,
    strength,
  });
  return { ok: true, id: conceptId };
}

export async function removePrerequisite(
  actor: Actor,
  conceptId: string,
  prerequisiteId: string,
): Promise<boolean> {
  if (!isUuid(conceptId) || !isUuid(prerequisiteId)) return false;
  const link = await platformPrisma.conceptPrerequisite.findUnique({
    where: { conceptId_prerequisiteId: { conceptId, prerequisiteId } },
  });
  if (!link) return false;

  await platformPrisma.conceptPrerequisite.delete({
    where: { conceptId_prerequisiteId: { conceptId, prerequisiteId } },
  });
  await unreview(conceptId);

  await audit(
    actor,
    "curriculum.concept_prerequisite_removed",
    conceptId,
    null,
    { prerequisiteId },
  );
  return true;
}

/**
 * A concept's review covers its outcomes and its prerequisites as well as its
 * name, so changing any of them sends it back to review.
 */
async function unreview(conceptId: string) {
  await platformPrisma.concept.update({
    where: { id: conceptId },
    data: { reviewedAt: null, reviewedById: null },
  });
}

async function allEdges(): Promise<PrerequisiteEdge[]> {
  const rows = await platformPrisma.conceptPrerequisite.findMany({
    select: { conceptId: true, prerequisiteId: true },
  });
  return rows;
}

async function audit(
  actor: Actor,
  action: string,
  entityId: string,
  after?: unknown,
  before?: unknown,
) {
  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: "PLATFORM_ADMIN",
    action,
    entityType: "concept",
    entityId,
    before,
    after,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id names no concept — "not found", never a 500 from Postgres. */
function isUuid(value: string): boolean {
  return UUID.test(value);
}
