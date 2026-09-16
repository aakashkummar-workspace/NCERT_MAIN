/**
 * Re-file the NCERT questions that `import-ncert-questions.ts` put under the
 * wrong chapter, and retire the old-syllabus Class 9 Mathematics chapters.
 *
 *     npx tsx scripts/fix-ncert-filing.ts            # dry run
 *     npx tsx scripts/fix-ncert-filing.ts --commit
 *
 * Run `npm run db:seed` first: it creates the Class 10 book subjects and the
 * new Class 9 chapter titles this script files questions into.
 *
 * ---------------------------------------------------------------------------
 * What went wrong
 * ---------------------------------------------------------------------------
 * The importer resolved a question's chapter from (class, subject name,
 * chapter NUMBER). Class 10 English and Social Science are several books that
 * each number from 1, so Footprints went into First Flight and History,
 * Economics and Political Science into Geography. Class 9 Mathematics and
 * Science questions come from the new NCERT books, filed against the old
 * syllabus's chapters. Class 9 is fixed by the seed renaming those chapters;
 * Class 10 needs the questions themselves moved, which is this script.
 *
 * ---------------------------------------------------------------------------
 * How a question is found
 * ---------------------------------------------------------------------------
 * The importer kept no source id, but it did store `content_hash`, computed
 * from the stem and options. That hash is recomputed here with the importer's
 * own normalisation, and a question is moved only if exactly one row in the
 * organization matches it. A hash that matches nothing or several is reported
 * and left alone — moving the wrong question is worse than not moving one.
 *
 * ---------------------------------------------------------------------------
 * Tenant data goes through the tenant path
 * ---------------------------------------------------------------------------
 * Questions are tenant rows, so they are moved over DATABASE_URL as
 * `sahayak_app` with `set_config('app.organization_id', …, true)` — the same
 * policy every page is held to — not over the superuser connection the
 * importer used. Curriculum rows (the stale chapters) go over the platform
 * role. Each half is one transaction.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const SOURCE_DIR = "C:\\dev\\sirah_project\\NCERT\\data";

/** Which book goes to which Class 10 subject. First Flight and Geography stay put. */
const BOOK_SUBJECT: Record<string, string> = {
  jefp1: "ENGFP",
  jess2: "SSTEC",
  jess3: "SSTHI",
  jess4: "SSTPS",
};

/** Old-syllabus Class 9 Mathematics chapters with no counterpart in Ganita Manjari Part 1. */
const STALE_CLASS9_MATH = [9, 10, 11, 12];

type Source = {
  class?: number;
  bookCode?: string;
  chapter?: number | string;
  question?: string;
  stem?: string;
  options?: string[];
};

/** Byte-for-byte the importer's hash. Any drift here matches nothing, loudly. */
function contentHash(stem: string, options: string[]): string {
  const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = ["MCQ", normalise(stem)];
  parts.push(
    ...options
      .map((text) => normalise(String(text).trim()))
      .sort()
      .map((text, index) => `${index}:${text}`),
  );
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function loadSources(): Source[] {
  const all: Source[] = [];
  for (const file of fs.readdirSync(SOURCE_DIR)) {
    if (!file.startsWith("questions.") || !file.endsWith(".json")) continue;
    const content = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, file), "utf8"));
    all.push(...(Array.isArray(content) ? content : (content.questions ?? [])));
  }
  return all;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const platform = new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });

  // --- Curriculum: resolve target chapters (read over the platform role) ----
  const grade10 = await platform.grade.findFirstOrThrow({
    where: { number: 10, board: { code: "CBSE" } },
    select: { subjects: { select: { id: true, code: true, chapters: { select: { id: true, number: true } } } } },
  });
  const target = new Map<string, { subjectId: string; chapters: Map<number, string> }>();
  for (const s of grade10.subjects) {
    target.set(s.code, { subjectId: s.id, chapters: new Map(s.chapters.map((c) => [c.number, c.id])) });
  }
  for (const code of Object.values(BOOK_SUBJECT)) {
    if (!target.get(code)?.chapters.size) {
      throw new Error(`Class 10 subject ${code} has no chapters. Run npm run db:seed first.`);
    }
  }

  // --- Plan the moves -------------------------------------------------------
  const sources = loadSources().filter((q) => q.class === 10 && q.bookCode && BOOK_SUBJECT[q.bookCode]);
  const wanted = new Map<string, { subjectId: string; chapterId: string; label: string }>();
  let unresolvedChapter = 0;
  for (const q of sources) {
    const stem = (q.question ?? q.stem ?? "").trim();
    if (stem.length < 5 || !Array.isArray(q.options) || q.options.length < 2) continue;
    const dest = target.get(BOOK_SUBJECT[q.bookCode!]!)!;
    const chapterId = dest.chapters.get(Number(q.chapter));
    if (!chapterId) {
      unresolvedChapter++;
      continue;
    }
    wanted.set(contentHash(stem, q.options), {
      subjectId: dest.subjectId,
      chapterId,
      label: `${BOOK_SUBJECT[q.bookCode!]} ch${q.chapter}`,
    });
  }

  // Imported questions live in one organization; find it rather than name it.
  const orgs = await platform.question.groupBy({ by: ["organizationId"], where: { source: "IMPORTED" } });
  if (orgs.length !== 1) throw new Error(`Expected imported questions in one organization, found ${orgs.length}.`);
  const organizationId = orgs[0]!.organizationId;

  const moves = { planned: 0, alreadyRight: 0, noMatch: 0, ambiguous: 0 };
  const byDestination: Record<string, number> = {};

  const runMoves = async (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use">) => {
    await tx.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`;
    const rows = await tx.question.findMany({
      where: { source: "IMPORTED", deletedAt: null },
      select: { id: true, contentHash: true, subjectId: true, chapterId: true },
    });
    const byHash = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.contentHash) continue;
      const key = Buffer.from(row.contentHash).toString("hex");
      byHash.set(key, [...(byHash.get(key) ?? []), row]);
    }
    for (const [hash, dest] of wanted) {
      const matches = byHash.get(hash) ?? [];
      if (matches.length === 0) { moves.noMatch++; continue; }
      if (matches.length > 1) { moves.ambiguous++; continue; }
      const row = matches[0]!;
      if (row.subjectId === dest.subjectId && row.chapterId === dest.chapterId) { moves.alreadyRight++; continue; }
      moves.planned++;
      byDestination[dest.label] = (byDestination[dest.label] ?? 0) + 1;
      if (commit) {
        await tx.question.update({
          where: { id: row.id },
          data: { subjectId: dest.subjectId, chapterId: dest.chapterId },
        });
      }
    }
  };

  // --- Stale Class 9 chapters (platform role) -------------------------------
  const staleChapters = await platform.chapter.findMany({
    where: {
      number: { in: STALE_CLASS9_MATH },
      subject: { code: "MATH", grade: { number: 9, board: { code: "CBSE" } } },
    },
    select: { id: true, number: true, title: true, _count: { select: { questions: true, topics: true } } },
  });
  const deletable = staleChapters.filter((c) => c._count.questions === 0);
  const kept = staleChapters.filter((c) => c._count.questions > 0);

  if (commit) {
    await app.$transaction(async (tx) => runMoves(tx), { timeout: 120_000, maxWait: 10_000 });
    if (deletable.length > 0) {
      await platform.chapter.deleteMany({ where: { id: { in: deletable.map((c) => c.id) } } });
    }
  } else {
    await app.$transaction(async (tx) => runMoves(tx), { timeout: 120_000, maxWait: 10_000 });
  }

  console.log(`\nNCERT re-filing — ${commit ? "COMMIT" : "dry run"}`);
  console.log(`  source questions from Footprints / Economics / History / Politics: ${wanted.size}`);
  console.log(`  moves ${commit ? "made" : "planned"}: ${moves.planned}`);
  for (const [label, count] of Object.entries(byDestination).sort()) console.log(`      ${label.padEnd(10)} ${count}`);
  console.log(`  already in the right place: ${moves.alreadyRight}`);
  console.log(`  no matching question (left alone): ${moves.noMatch}`);
  console.log(`  more than one match (left alone): ${moves.ambiguous}`);
  console.log(`  source chapter not found: ${unresolvedChapter}`);
  console.log(`\n  old Class 9 Maths chapters ${commit ? "removed" : "to remove"}: ${deletable.map((c) => `${c.number} ${c.title}`).join("; ") || "none"}`);
  if (kept.length) {
    console.log(`  old Class 9 Maths chapters KEPT because questions still use them: ${kept.map((c) => `${c.number} ${c.title} (${c._count.questions})`).join("; ")}`);
  }
  console.log(commit ? "\nWritten." : "\nNothing written. Re-run with --commit to apply.");

  await app.$disconnect();
  await platform.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
