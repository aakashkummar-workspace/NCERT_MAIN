/**
 * Link imported NCERT questions to the learning outcome each one tests.
 *
 *     npx tsx scripts/tag-questions.ts prisma/question-outcomes/cbse-10-mathematics.json
 *     npx tsx scripts/tag-questions.ts <mapping.json> --commit
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Mastery is measured per concept, reached question → outcome → concept
 * (`core/mastery/ledger.ts`). The NCERT importer approved 3,857 questions with
 * no outcome at all, so every one of them could be scored and none could ever
 * tell the product anything about a student. The app refuses to approve a
 * question without an outcome for exactly that reason; the importer wrote over
 * the superuser connection and never met the rule.
 *
 * ---------------------------------------------------------------------------
 * The mapping file
 * ---------------------------------------------------------------------------
 * One string of digits per chapter, one digit per question, in source-id order.
 * A digit is the outcome's 1-based position in that chapter of the curriculum
 * draft; `0` leaves the question untagged on purpose — usually content CBSE
 * removed, which must not count towards a student's mastery. A digit string
 * whose length disagrees with the number of questions in the chapter is an
 * error, not a truncation: a string one character short shifts every tag after
 * the gap onto the wrong question, and nothing downstream would look wrong.
 *
 * ---------------------------------------------------------------------------
 * The rules it holds
 * ---------------------------------------------------------------------------
 * - The outcome must belong to the question's OWN chapter. `checkCurriculumFit`
 *   makes that an error in the app, because evidence attributed to the wrong
 *   syllabus is wrong forever with nothing looking wrong.
 * - One primary outcome at full weight, written exactly as `linkOutcomes` in
 *   `core/questions` writes one, and `primaryOutcomeId` set to match.
 * - A question that already has an outcome is left alone. A teacher may have
 *   tagged it, and a bulk script does not overrule a person.
 * - Tenant rows are written over DATABASE_URL as `sahayak_app` inside the
 *   organization's context, the same policy every page is held to.
 * - Dry run by default; the dry run and the commit share one path.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const SOURCE_DIR = "C:\\dev\\sirah_project\\NCERT\\data";

type Mapping = {
  draft: string;
  book?: string;
  chapters: Record<string, string>;
  /**
   * Outcome codes, in digit order, for a chapter the draft does not define —
   * Class 10 Mathematics chapter 6 is the seeded worked example and keeps its
   * own authored outcomes (SIM-1 to SIM-5) rather than a drafted set.
   */
  extraChapters?: Record<string, string[]>;
};
type Draft = {
  grade: number;
  subject: string;
  chapters: { number: number; topics: { outcomes: { code: string }[] }[] }[];
};
type Source = {
  id: string;
  class?: number;
  subject?: string;
  bookCode?: string;
  chapter?: number | string;
  question?: string;
  stem?: string;
  options?: string[];
};

/** Byte-for-byte the importer's content hash. */
function contentHash(stem: string, options: string[]): string {
  const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = ["MCQ", normalise(stem)];
  parts.push(...options.map((t) => normalise(String(t).trim())).sort().map((t, i) => `${i}:${t}`));
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

async function main() {
  const file = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!file) throw new Error("Usage: tsx scripts/tag-questions.ts <mapping.json> [--commit]");

  const mapping = JSON.parse(fs.readFileSync(file, "utf8")) as Mapping;
  const draft = JSON.parse(fs.readFileSync(mapping.draft, "utf8")) as Draft;
  const sourceSubject = draft.subject.replace(/ – .*/, "").toLowerCase();

  const sources: Source[] = [];
  for (const name of fs.readdirSync(SOURCE_DIR)) {
    if (!name.startsWith("questions.") || !name.endsWith(".json")) continue;
    const content = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, name), "utf8"));
    for (const q of (Array.isArray(content) ? content : (content.questions ?? [])) as Source[]) {
      if (q.class !== draft.grade || String(q.subject).toLowerCase() !== sourceSubject) continue;
      if (mapping.book && q.bookCode !== mapping.book) continue;
      sources.push(q);
    }
  }

  const errors: string[] = [];
  // hash → outcome code, and the source id for a readable report.
  const wanted = new Map<string, { code: string; id: string; chapter: number }>();
  let leftUntagged = 0;

  const chapterList = [
    ...draft.chapters.map((c) => ({ number: c.number, codes: c.topics.flatMap((t) => t.outcomes.map((o) => o.code)) })),
    ...Object.entries(mapping.extraChapters ?? {}).map(([n, codes]) => ({ number: Number(n), codes })),
  ];
  for (const chapter of chapterList) {
    const digits = (mapping.chapters[String(chapter.number)] ?? "").replace(/\s+/g, "");
    const outcomes = chapter.codes.map((code) => ({ code }));
    const inChapter = sources
      .filter((q) => Number(q.chapter) === chapter.number)
      .sort((a, b) => a.id.localeCompare(b.id));

    if (!mapping.chapters[String(chapter.number)]) {
      errors.push(`ch${chapter.number}: no mapping for its ${inChapter.length} questions`);
      continue;
    }
    if (digits.length !== inChapter.length) {
      errors.push(`ch${chapter.number}: ${digits.length} tags for ${inChapter.length} questions`);
      continue;
    }
    for (const [index, q] of inChapter.entries()) {
      const digit = Number(digits[index]);
      if (!Number.isInteger(digit) || digit > outcomes.length) {
        errors.push(`${q.id}: tag '${digits[index]}' but ch${chapter.number} has ${outcomes.length} outcomes`);
        continue;
      }
      if (digit === 0) {
        leftUntagged++;
        continue;
      }
      const stem = (q.question ?? q.stem ?? "").trim();
      if (!Array.isArray(q.options) || q.options.length < 2 || stem.length < 5) continue;
      wanted.set(contentHash(stem, q.options), { code: outcomes[digit - 1]!.code, id: q.id, chapter: chapter.number });
    }
  }
  const mappedChapters = new Set(chapterList.map((c) => c.number));
  const unmapped = sources.filter((q) => !mappedChapters.has(Number(q.chapter)));

  const app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const platform = new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });

  const orgs = await platform.question.groupBy({ by: ["organizationId"], where: { source: "IMPORTED" } });
  if (orgs.length !== 1) errors.push(`expected imported questions in one organization, found ${orgs.length}`);

  if (errors.length > 0) {
    report(draft, commit, errors, null);
    await app.$disconnect();
    await platform.$disconnect();
    process.exitCode = 1;
    return;
  }
  const organizationId = orgs[0]!.organizationId;

  const counts = { tagged: 0, alreadyTagged: 0, leftUntagged, notFound: 0, ambiguous: 0, wrongChapter: 0 };
  const problems: string[] = [];

  await app.$transaction(
    async (tx) => {
      await tx.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`;
      const rows = await tx.question.findMany({
        where: { source: "IMPORTED", deletedAt: null },
        select: { id: true, contentHash: true, chapterId: true, _count: { select: { outcomes: true } } },
      });
      const byHash = new Map<string, typeof rows>();
      for (const row of rows) {
        if (!row.contentHash) continue;
        const key = Buffer.from(row.contentHash).toString("hex");
        byHash.set(key, [...(byHash.get(key) ?? []), row]);
      }

      // Every outcome code the mapping uses, with the chapter it belongs to.
      const codes = [...new Set([...wanted.values()].map((w) => w.code))];
      const outcomeRows = await tx.learningOutcome.findMany({
        where: { code: { in: codes } },
        select: { id: true, code: true, topic: { select: { chapterId: true } } },
      });
      const outcomesByCode = new Map<string, typeof outcomeRows>();
      for (const o of outcomeRows) outcomesByCode.set(o.code, [...(outcomesByCode.get(o.code) ?? []), o]);

      for (const [hash, want] of wanted) {
        const matches = byHash.get(hash) ?? [];
        if (matches.length === 0) { counts.notFound++; problems.push(`${want.id}: no matching question`); continue; }
        if (matches.length > 1) { counts.ambiguous++; problems.push(`${want.id}: ${matches.length} matching questions`); continue; }
        const question = matches[0]!;
        if (question._count.outcomes > 0) { counts.alreadyTagged++; continue; }

        // The outcome must sit in the question's own chapter.
        const outcome = (outcomesByCode.get(want.code) ?? []).find((o) => o.topic.chapterId === question.chapterId);
        if (!outcome) {
          counts.wrongChapter++;
          problems.push(`${want.id}: ${want.code} is not an outcome of the question's chapter`);
          continue;
        }
        counts.tagged++;
        if (commit) {
          await tx.questionOutcome.create({
            data: { questionId: question.id, learningOutcomeId: outcome.id, isPrimary: true, weight: 1.0 },
          });
          await tx.question.update({ where: { id: question.id }, data: { primaryOutcomeId: outcome.id } });
        }
      }
      if (commit && (counts.notFound || counts.ambiguous || counts.wrongChapter)) {
        // All or nothing: a partial tagging is harder to reason about than none.
        throw new Error(`Refusing to commit with ${problems.length} problem(s).`);
      }
    },
    { timeout: 300_000, maxWait: 10_000 },
  ).catch((error: Error) => problems.push(error.message));

  report(draft, commit, problems, { ...counts, questionsInUnmappedChapters: unmapped.length });
  await app.$disconnect();
  await platform.$disconnect();
  if (problems.length) process.exitCode = 1;
}

function report(draft: Draft, commit: boolean, problems: string[], counts: Record<string, number> | null) {
  console.log(`\nClass ${draft.grade} ${draft.subject} — ${commit ? "COMMIT" : "dry run"}`);
  for (const p of problems.slice(0, 25)) console.log(`  ERROR  ${p}`);
  if (problems.length > 25) console.log(`  … and ${problems.length - 25} more`);
  if (counts) console.log("\n" + Object.entries(counts).map(([k, v]) => `  ${k.padEnd(28)} ${v}`).join("\n"));
  if (!problems.length) console.log(commit ? "\nWritten." : "\nNothing written. Re-run with --commit to apply.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
