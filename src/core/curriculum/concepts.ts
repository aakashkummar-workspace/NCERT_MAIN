import "server-only";
import { prisma } from "@/db/client";

/**
 * Concept reads, on the curriculum plane.
 *
 * These live here rather than in `core/mastery` because of where the data is,
 * not where it is used. Concepts carry no `organization_id`: their policy is
 * `for select using (true)` and the app role has no write grant on them at all,
 * so they are read outside `withTenant` — and `core/curriculum` is the module
 * the layering rules exempt for exactly that. A mastery module reaching for the
 * raw client would be widening that exemption to a place it does not belong.
 */

export type ConceptContext = {
  name: string;
  /** The chapters this concept is tested by, so a student recognises it. */
  chapters: string[];
  subjects: string[];
};

export async function conceptContext(
  conceptIds: string[],
): Promise<Map<string, ConceptContext>> {
  if (conceptIds.length === 0) return new Map();

  const concepts = await prisma.concept.findMany({
    where: { id: { in: conceptIds } },
    include: {
      outcomes: {
        include: {
          outcome: {
            include: { topic: { include: { chapter: { include: { subject: true } } } } },
          },
        },
      },
    },
  });

  return new Map(
    concepts.map((concept) => [
      concept.id,
      {
        name: concept.name,
        chapters: [
          ...new Set(concept.outcomes.map((o) => o.outcome.topic.chapter.title)),
        ],
        subjects: [
          ...new Set(
            concept.outcomes.map((o) => o.outcome.topic.chapter.subject.name),
          ),
        ],
      },
    ]),
  );
}

export type Coverage = {
  concepts: number;
  outcomes: number;
  coveredOutcomes: number;
  /** Outcomes no concept covers, so answers to them can inform nothing. */
  uncovered: { code: string; statement: string; chapter: string }[];
};

/**
 * How much of the curriculum can produce mastery at all.
 *
 * An outcome no concept covers is a real hole: a question filed under it is
 * written, approved, sat, marked — and then informs nothing. Nothing on a
 * teacher's screen says so, which is how a product ends up with an analytics
 * page that is empty for reasons nobody can explain six months later.
 *
 * Concepts are authored by somebody who teaches the subject, exactly like the
 * outcomes themselves, and most seeded outcomes have none yet. That is a
 * designed state, not a bug — this function is what keeps it from being a
 * silent one.
 */
export async function conceptCoverage(): Promise<Coverage> {
  const [concepts, outcomes] = await Promise.all([
    prisma.concept.count(),
    prisma.learningOutcome.findMany({
      include: {
        concepts: { select: { conceptId: true } },
        topic: { include: { chapter: { select: { title: true } } } },
      },
      orderBy: { code: "asc" },
    }),
  ]);

  const uncovered = outcomes
    .filter((outcome) => outcome.concepts.length === 0)
    .map((outcome) => ({
      code: outcome.code,
      statement: outcome.statement,
      chapter: outcome.topic.chapter.title,
    }));

  return {
    concepts,
    outcomes: outcomes.length,
    coveredOutcomes: outcomes.length - uncovered.length,
    uncovered,
  };
}

/**
 * What each concept is built on.
 *
 * Prerequisites are curriculum structure, not tenant data — "similar triangles
 * needs ratio" is true in every school — so they live on the global plane with
 * everything else here.
 *
 * Used by gap detection to answer the question a teacher actually has: not
 * "what are they bad at" but "what should I teach first". A class stuck on
 * similar triangles because they cannot do ratio needs a ratio lesson, and
 * reteaching the symptom would waste the one they get.
 */
export async function prerequisitesOf(
  conceptIds: string[],
): Promise<Map<string, string[]>> {
  if (conceptIds.length === 0) return new Map();

  const links = await prisma.conceptPrerequisite.findMany({
    where: { conceptId: { in: conceptIds } },
    orderBy: { strength: "desc" },
  });

  const map = new Map<string, string[]>();
  for (const link of links) {
    const list = map.get(link.conceptId) ?? [];
    list.push(link.prerequisiteId);
    map.set(link.conceptId, list);
  }
  return map;
}

/**
 * The learning outcomes a concept is made of.
 *
 * The join a remedial paper needs: questions are filed against outcomes, gaps
 * are found against concepts, and this is the only edge between them. Lives
 * here with the other curriculum-plane reads rather than in `core/gaps`,
 * because the raw client is what reaching across the plane costs and this
 * module is the one that pays it.
 */
export async function outcomeIdsFor(conceptId: string): Promise<string[]> {
  const links = await prisma.conceptOutcome.findMany({
    where: { conceptId },
    select: { learningOutcomeId: true },
  });
  return links.map((link) => link.learningOutcomeId);
}

/**
 * Every concept that touches one of these subjects, with its name.
 *
 * The denominator a report needs: "secure on 2 of 5 measured" and "secure on 2
 * of the 40 ideas in the syllabus" are wildly different statements about a
 * child, and only one of them is true. Without this the report can only count
 * what it has already measured, which is the definition of a flattering
 * denominator.
 *
 * Reads outside `withTenant` like everything else here — concepts carry no
 * organization_id and their policy is `for select using (true)`.
 */
export async function conceptsForSubjects(
  subjectIds: string[],
): Promise<{ conceptId: string; conceptName: string }[]> {
  if (subjectIds.length === 0) return [];

  const links = await prisma.conceptOutcome.findMany({
    where: {
      outcome: {
        topic: { chapter: { subjectId: { in: subjectIds } } },
      },
    },
    select: { conceptId: true, concept: { select: { name: true } } },
  });

  const byId = new Map<string, string>();
  for (const link of links) byId.set(link.conceptId, link.concept.name);

  return [...byId.entries()]
    .map(([conceptId, conceptName]) => ({ conceptId, conceptName }))
    // Sorted, not incidental: a report generated twice must list them the same
    // way, or two printouts of the same term disagree.
    .sort((a, b) => a.conceptName.localeCompare(b.conceptName));
}
