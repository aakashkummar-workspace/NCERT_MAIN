/**
 * Stamp every imported NCERT question with who holds the copyright on its
 * wording.
 *
 *     npx tsx scripts/mark-question-provenance.ts            # dry run
 *     npx tsx scripts/mark-question-provenance.ts --commit
 *
 * ---------------------------------------------------------------------------
 * Why this has to be exact
 * ---------------------------------------------------------------------------
 * The library copies ORIGINAL questions into every school. A verbatim NCERT
 * Exemplar problem stamped ORIGINAL would be handed to every customer of a
 * commercial product without the permission NCERT has not yet given. So the
 * rule is conservative in one direction only: a question whose wording appears
 * in either Exemplar source file is NCERT_EXEMPLAR, even if it was also present
 * in another file and imported from there.
 *
 * Questions are matched by content hash, computed exactly as
 * scripts/import-ncert-questions.ts computed it — the importer kept no source
 * id, and the hash is the one identity every later script has relied on.
 *
 * Only APPROVED or ARCHIVED questions that came from the MCQ files are touched.
 * The 23 sample-paper drafts are CBSE's wording, not ours, and stay unstamped —
 * which the library reads as "not shareable".
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const SOURCE_DIR = "C:\\dev\\sirah_project\\NCERT\\data";
const EXEMPLAR_FILES = ["questions.exemplar.json", "questions.exemplar-recovered.json"];

type Raw = { question?: string; stem?: string; options?: unknown };

/** Identical to computeContentHash in scripts/import-ncert-questions.ts. */
function contentHash(stem: string, options: string[]): string {
  const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = [
    "MCQ",
    normalise(stem),
    ...options
      .map((text) => normalise(text))
      .sort()
      .map((text, index) => `${index}:${text}`),
  ];
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function exemplarHashes(): Set<string> {
  const hashes = new Set<string>();
  for (const file of EXEMPLAR_FILES) {
    const content = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, file), "utf8")) as
      | Raw[]
      | { questions?: Raw[] };
    const rows = Array.isArray(content) ? content : (content.questions ?? []);
    for (const row of rows) {
      const stem = String(row.question ?? row.stem ?? "").trim();
      const options = Array.isArray(row.options) ? row.options.map((o) => String(o).trim()) : [];
      if (stem.length < 5 || options.length < 2) continue;
      hashes.add(contentHash(stem, options));
    }
  }
  return hashes;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const exemplar = exemplarHashes();
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

  const questions = await db.question.findMany({
    where: {
      source: "IMPORTED",
      type: "MCQ",
      deletedAt: null,
      libraryOriginId: null,
      status: { in: ["APPROVED", "ARCHIVED"] },
    },
    select: { id: true, contentHash: true, provenance: true, status: true },
  });

  const toExemplar: string[] = [];
  const toOriginal: string[] = [];
  let noHash = 0;
  for (const q of questions) {
    if (!q.contentHash) {
      noHash++;
      continue;
    }
    const hex = Buffer.from(q.contentHash).toString("hex");
    (exemplar.has(hex) ? toExemplar : toOriginal).push(q.id);
  }

  const approvedOriginal = questions.filter((q) => q.status === "APPROVED" && toOriginal.includes(q.id)).length;

  console.log(`\nQuestion provenance — ${commit ? "COMMIT" : "dry run"}`);
  console.log(`  exemplar hashes in source  ${exemplar.size}`);
  console.log(`  imported MCQs examined     ${questions.length}`);
  console.log(`  NCERT_EXEMPLAR             ${toExemplar.length}`);
  console.log(`  ORIGINAL                   ${toOriginal.length} (${approvedOriginal} approved, the rest archived)`);
  console.log(`  without a hash (skipped)   ${noHash}`);

  if (commit) {
    await db.$transaction([
      db.question.updateMany({ where: { id: { in: toExemplar } }, data: { provenance: "NCERT_EXEMPLAR" } }),
      db.question.updateMany({ where: { id: { in: toOriginal } }, data: { provenance: "ORIGINAL" } }),
    ]);
    console.log("\nDone.");
  } else {
    console.log("\nNothing written. Re-run with --commit to apply.");
  }
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
