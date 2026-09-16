/**
 * Import a curriculum draft — topics, learning outcomes, concepts and
 * prerequisites for one subject — from prisma/curriculum-drafts/*.json.
 *
 *     npx tsx scripts/import-curriculum.ts prisma/curriculum-drafts/cbse-10-mathematics.json
 *     npx tsx scripts/import-curriculum.ts <file> --commit
 *
 * ---------------------------------------------------------------------------
 * Dry run by default
 * ---------------------------------------------------------------------------
 * Without --commit nothing is written. A concept changes what every school
 * measures, and there is no delete for one (CLAUDE.md, "Authoring concepts"),
 * so the first run of a draft should always be the one that shows what WOULD
 * happen. The dry run and the commit share one planning path, so the preview
 * cannot disagree with the outcome — the roster importer's rule.
 *
 * ---------------------------------------------------------------------------
 * The same checks the authoring screens apply
 * ---------------------------------------------------------------------------
 * `checkOutcomeStatement` and `checkConceptName` are the pure functions the
 * editor runs live and again on save, imported rather than repeated. In the
 * editor an outcome warning never blocks, because a person is looking at it;
 * here nobody is, so a failing statement fails the whole draft. A bulk import
 * is exactly where a weak statement arrives unread.
 *
 * ---------------------------------------------------------------------------
 * The platform role, never the superuser
 * ---------------------------------------------------------------------------
 * Writes go over PLATFORM_DATABASE_URL as `sahayak_platform`, the role the
 * curriculum console uses. DIRECT_URL would work and would prove nothing: it
 * bypasses the write policies that keep the curriculum plane a platform
 * concern. The question importer beside this file took that shortcut and
 * approved 3,857 questions with no learning outcome, which the app itself
 * refuses to do.
 *
 * ---------------------------------------------------------------------------
 * Idempotent, and all-or-nothing
 * ---------------------------------------------------------------------------
 * Topics match on (chapter, title), outcomes on (topic, code), concepts on
 * name. Re-running a committed draft changes nothing. Every write for a draft
 * happens in one transaction, so a failure halfway leaves no half-authored
 * subject behind.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient, type BloomLevel, type Competency } from "@prisma/client";
import { checkOutcomeStatement } from "../src/core/curriculum/outcome-quality";
import {
  checkConceptName,
  conceptSlug,
  uniqueConceptSlug,
  wouldCycle,
} from "../src/core/curriculum/concept-rules";

type DraftOutcome = {
  code: string;
  statement: string;
  bloom: BloomLevel;
  competency: Competency;
  marks: number;
};
type Draft = {
  board: string;
  grade: number;
  subject: string;
  chapters: {
    number: number;
    topics: { title: string; outcomes: DraftOutcome[] }[];
    concepts: { name: string; outcomes: string[] }[];
  }[];
  prerequisites: { concept: string; requires: string }[];
};

const BLOOM = new Set(["REMEMBER", "UNDERSTAND", "APPLY", "ANALYSE", "EVALUATE", "CREATE"]);
const COMPETENCY = new Set([
  "KNOWLEDGE", "UNDERSTANDING", "APPLICATION", "PROBLEM_SOLVING", "ANALYSIS", "EVALUATION",
]);

async function main() {
  const file = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!file) throw new Error("Usage: tsx scripts/import-curriculum.ts <draft.json> [--commit]");

  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) throw new Error("PLATFORM_DATABASE_URL is not set — see .env.example.");

  const draft = JSON.parse(fs.readFileSync(file, "utf8")) as Draft;
  const db = new PrismaClient({ datasources: { db: { url } } });

  const errors: string[] = [];
  const warnings: string[] = [];

  // --- 1. Validate the draft on its own, before touching the database ------

  const codes = new Set<string>();
  const outcomeByCode = new Map<string, { chapter: number; topic: string; o: DraftOutcome }>();
  for (const chapter of draft.chapters) {
    for (const topic of chapter.topics) {
      if (topic.title.trim().length < 3) errors.push(`ch${chapter.number}: a topic has no title`);
      for (const o of topic.outcomes) {
        if (codes.has(o.code)) errors.push(`${o.code}: code used twice in the draft`);
        codes.add(o.code);
        outcomeByCode.set(o.code, { chapter: chapter.number, topic: topic.title, o });

        const quality = checkOutcomeStatement(o.statement);
        if (!quality.ok) errors.push(`${o.code}: ${quality.reason}  — "${o.statement}"`);
        if (!BLOOM.has(o.bloom)) errors.push(`${o.code}: unknown bloom level ${o.bloom}`);
        if (!COMPETENCY.has(o.competency)) errors.push(`${o.code}: unknown competency ${o.competency}`);
        if (!Number.isInteger(o.marks) || o.marks < 1 || o.marks > 10) {
          errors.push(`${o.code}: typical marks must be a whole number from 1 to 10`);
        }
      }
    }
  }

  const conceptNames = new Set<string>();
  const coveredBy = new Map<string, string>();
  for (const chapter of draft.chapters) {
    for (const concept of chapter.concepts) {
      const lower = concept.name.trim().toLowerCase();
      if (conceptNames.has(lower)) errors.push(`concept "${concept.name}" appears twice`);
      conceptNames.add(lower);

      for (const problem of checkConceptName(concept.name)) {
        (problem.severity === "error" ? errors : warnings).push(
          `concept "${concept.name}": ${problem.message}`,
        );
      }
      if (concept.outcomes.length === 0) errors.push(`concept "${concept.name}" measures nothing`);
      // Thin, not wrong: one outcome rarely reaches the evidence threshold.
      if (concept.outcomes.length === 1) {
        warnings.push(`concept "${concept.name}" rests on one outcome and may rarely have enough evidence`);
      }
      for (const code of concept.outcomes) {
        const found = outcomeByCode.get(code);
        if (!found) errors.push(`concept "${concept.name}" links ${code}, which the draft does not define`);
        else if (found.chapter !== chapter.number) {
          errors.push(`concept "${concept.name}" (ch${chapter.number}) links ${code} from ch${found.chapter}`);
        }
        // The same answer counting towards two concepts splits the evidence
        // for both — the rule the concept editor enforces.
        const other = coveredBy.get(code);
        if (other) errors.push(`${code} is linked to both "${other}" and "${concept.name}"`);
        coveredBy.set(code, concept.name);
      }
    }
  }
  for (const code of codes) {
    if (!coveredBy.has(code)) warnings.push(`${code} is not covered by any concept, so it can never inform mastery`);
  }
  // A prerequisite may name a concept that already exists, on either side —
  // across class years is exactly where a root cause tends to live: weak on
  // Class 10 progressions BECAUSE Class 9 sequences never landed, an edge the
  // Class 9 draft adds after Class 10 was imported. At least one side must be
  // this draft's own, so a draft cannot rewire concepts it did not author.
  const externalNames = new Set<string>();
  for (const edge of draft.prerequisites) {
    const ends = [edge.concept, edge.requires].map((name) => name.trim().toLowerCase());
    if (!ends.some((name) => conceptNames.has(name))) {
      errors.push(`prerequisite "${edge.concept}" requires "${edge.requires}" involves no concept from this draft`);
    }
    for (const name of ends) if (!conceptNames.has(name)) externalNames.add(name);
  }

  // --- 2. Resolve against the database ------------------------------------

  const subject = await db.subject.findFirst({
    where: {
      name: draft.subject,
      grade: { number: draft.grade, board: { code: draft.board } },
    },
    select: { id: true, chapters: { select: { id: true, number: true, title: true } } },
  });
  if (!subject) {
    errors.push(`no ${draft.board} Class ${draft.grade} ${draft.subject} in the database`);
  }

  const chapterIdByNumber = new Map(subject?.chapters.map((c) => [c.number, c.id]) ?? []);
  for (const chapter of draft.chapters) {
    if (subject && !chapterIdByNumber.has(chapter.number)) {
      errors.push(`chapter ${chapter.number} does not exist for ${draft.subject}`);
    }
  }

  // A concept name already in use belongs to someone. Reusing it silently would
  // attach this draft's outcomes to whatever that concept already measures.
  const existingConcepts = await db.concept.findMany({ select: { id: true, name: true, slug: true } });
  const existingByName = new Map(existingConcepts.map((c) => [c.name.trim().toLowerCase(), c]));
  const takenSlugs = new Set(existingConcepts.map((c) => c.slug));
  for (const name of externalNames) {
    const matches = existingConcepts.filter((c) => c.name.trim().toLowerCase() === name);
    if (matches.length !== 1) {
      errors.push(
        `prerequisite names "${name}", which is neither in this draft nor exactly one existing concept (found ${matches.length})`,
      );
    }
  }

  if (errors.length > 0) return report(draft, errors, warnings, null, commit, db);

  // --- 3. Plan -------------------------------------------------------------

  const plan = {
    topicsCreated: 0, topicsReused: 0,
    outcomesCreated: 0, outcomesReused: 0,
    conceptsCreated: 0, conceptsReused: 0,
    linksCreated: 0, prerequisitesCreated: 0,
  };

  const run = async (tx: Pick<PrismaClient, "topic" | "learningOutcome" | "concept" | "conceptOutcome" | "conceptPrerequisite">) => {
    const outcomeIdByCode = new Map<string, string>();
    // Outcomes that already exist in the database. Only these can already be
    // covered by some other concept, and the dry run must check them exactly
    // as the commit does, or the preview is more optimistic than the outcome.
    const existingOutcomeIds = new Set<string>();

    for (const chapter of draft.chapters) {
      const chapterId = chapterIdByNumber.get(chapter.number)!;
      for (const [topicIndex, topic] of chapter.topics.entries()) {
        let topicRow = await tx.topic.findFirst({ where: { chapterId, title: topic.title }, select: { id: true } });
        if (topicRow) plan.topicsReused++;
        else {
          plan.topicsCreated++;
          const id = randomUUID();
          if (commit) await tx.topic.create({ data: { id, chapterId, title: topic.title, sortOrder: topicIndex + 1 } });
          topicRow = { id };
        }

        for (const [outcomeIndex, o] of topic.outcomes.entries()) {
          const existing = await tx.learningOutcome.findFirst({
            where: { topicId: topicRow.id, code: o.code }, select: { id: true },
          });
          if (existing) {
            plan.outcomesReused++;
            outcomeIdByCode.set(o.code, existing.id);
            existingOutcomeIds.add(existing.id);
            continue;
          }
          plan.outcomesCreated++;
          const id = randomUUID();
          if (commit) {
            await tx.learningOutcome.create({
              data: {
                id, topicId: topicRow.id, code: o.code, statement: o.statement.trim(),
                bloomLevel: o.bloom, competency: o.competency, typicalMarks: o.marks,
                sortOrder: outcomeIndex + 1,
              },
            });
          }
          outcomeIdByCode.set(o.code, id);
        }
      }
    }

    const conceptIdByName = new Map<string, string>();
    for (const chapter of draft.chapters) {
      for (const concept of chapter.concepts) {
        const key = concept.name.trim().toLowerCase();
        const existing = existingByName.get(key);
        let conceptId: string;
        if (existing) {
          // Only reuse a concept this draft already created: its slug is the
          // one this name derives to, and every outcome it measures is one of
          // ours. Anything else is somebody else's concept with the same name.
          const links = await tx.conceptOutcome.findMany({
            where: { conceptId: existing.id },
            select: { outcome: { select: { code: true } } },
          });
          const foreign = links.filter((l) => !codes.has(l.outcome.code));
          if (!existing.slug.startsWith(conceptSlug(concept.name)) || foreign.length > 0) {
            throw new Error(
              `A concept named "${concept.name}" already exists and measures outcomes outside this draft. Rename it in the draft.`,
            );
          }
          plan.conceptsReused++;
          conceptId = existing.id;
        } else {
          plan.conceptsCreated++;
          conceptId = randomUUID();
          const slug = uniqueConceptSlug(concept.name, takenSlugs);
          takenSlugs.add(slug);
          if (commit) await tx.concept.create({ data: { id: conceptId, name: concept.name.trim(), slug } });
        }
        conceptIdByName.set(key, conceptId);

        for (const code of concept.outcomes) {
          const outcomeId = outcomeIdByCode.get(code)!;
          const covering = commit || existingOutcomeIds.has(outcomeId)
            ? await tx.conceptOutcome.findMany({ where: { learningOutcomeId: outcomeId }, select: { conceptId: true } })
            : [];
          if (covering.some((c) => c.conceptId === conceptId)) continue;
          if (covering.length > 0) {
            throw new Error(`${code} is already covered by another concept — refusing to split its evidence.`);
          }
          plan.linksCreated++;
          if (commit) {
            await tx.conceptOutcome.create({ data: { conceptId, learningOutcomeId: outcomeId, weight: 1 } });
          }
        }
      }
    }

    const edges = await tx.conceptPrerequisite.findMany({ select: { conceptId: true, prerequisiteId: true } });
    for (const edge of draft.prerequisites) {
      const conceptKey = edge.concept.trim().toLowerCase();
      const conceptId = conceptIdByName.get(conceptKey) ?? existingByName.get(conceptKey)!.id;
      const requiresKey = edge.requires.trim().toLowerCase();
      const prerequisiteId = conceptIdByName.get(requiresKey) ?? existingByName.get(requiresKey)!.id;
      if (edges.some((e) => e.conceptId === conceptId && e.prerequisiteId === prerequisiteId)) continue;
      // A cycle makes root-cause analysis either loop or send a teacher round
      // in circles. Checked against every edge including this draft's own.
      if (wouldCycle(edges, conceptId, prerequisiteId)) {
        throw new Error(`"${edge.concept}" requires "${edge.requires}" would create a prerequisite cycle.`);
      }
      edges.push({ conceptId, prerequisiteId });
      plan.prerequisitesCreated++;
      if (commit) await tx.conceptPrerequisite.create({ data: { conceptId, prerequisiteId } });
    }
  };

  try {
    if (commit) await db.$transaction(async (tx) => run(tx), { timeout: 120_000, maxWait: 10_000 });
    else await run(db);
  } catch (error) {
    errors.push((error as Error).message);
    return report(draft, errors, warnings, null, commit, db);
  }

  return report(draft, errors, warnings, plan, commit, db);
}

async function report(
  draft: Draft,
  errors: string[],
  warnings: string[],
  plan: Record<string, number> | null,
  commit: boolean,
  db: PrismaClient,
) {
  await db.$disconnect();
  console.log(`\n${draft.board} Class ${draft.grade} ${draft.subject} — ${commit ? "COMMIT" : "dry run"}`);
  for (const w of warnings) console.log(`  warning  ${w}`);
  for (const e of errors) console.log(`  ERROR    ${e}`);
  if (errors.length > 0) {
    console.log(`\n${errors.length} error(s). Nothing was written.`);
    process.exitCode = 1;
    return;
  }
  console.log("\n" + Object.entries(plan!).map(([k, v]) => `  ${k.padEnd(22)} ${v}`).join("\n"));
  console.log(commit ? "\nWritten." : "\nNothing written. Re-run with --commit to apply.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
