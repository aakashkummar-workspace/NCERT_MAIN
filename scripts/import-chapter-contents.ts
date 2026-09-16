/**
 * Writes prisma/chapter-contents/*.json into `chapters.contents`.
 *
 *     npx tsx scripts/import-chapter-contents.ts            # dry run: what would change
 *     npx tsx scripts/import-chapter-contents.ts --commit
 *
 * Run scripts/check-chapter-contents.mjs first; this refuses nothing the
 * checker would pass, and does not re-check the book text.
 *
 * Over PLATFORM_DATABASE_URL as `sahayak_platform`, the only role with a write
 * policy on the curriculum plane. One transaction: a book half-imported is a
 * syllabus index where some chapters are detailed and their neighbours are not,
 * with nothing saying why.
 *
 * A chapter is found by grade, subject code and chapter number, and its title
 * must match the book's — a contents block filed under the wrong chapter would
 * read as authoritative and be wrong, which is worse than no block at all.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";

type Target = { grade: number; subject: string; offset: number };

/** Book code → app subject. A two-book course continues its numbering. */
const BOOKS: Record<string, Target> = {
  iemh1: { grade: 9, subject: "MATH", offset: 0 },
  iesc1: { grade: 9, subject: "SCI", offset: 0 },
  iest1: { grade: 9, subject: "SST", offset: 0 },
  iebe1: { grade: 9, subject: "ENG", offset: 0 },
  ihga1: { grade: 9, subject: "HIN", offset: 0 },
  jemh1: { grade: 10, subject: "MATH", offset: 0 },
  jesc1: { grade: 10, subject: "SCI", offset: 0 },
  jess1: { grade: 10, subject: "SST", offset: 0 },
  jess2: { grade: 10, subject: "SSTEC", offset: 0 },
  jess3: { grade: 10, subject: "SSTHI", offset: 0 },
  jess4: { grade: 10, subject: "SSTPS", offset: 0 },
  jeff1: { grade: 10, subject: "ENG", offset: 0 },
  jefp1: { grade: 10, subject: "ENGFP", offset: 0 },
  jhks1: { grade: 10, subject: "HIN", offset: 0 },
  jhkr1: { grade: 10, subject: "HIN", offset: 12 },
  jhsp1: { grade: 10, subject: "HINB", offset: 0 },
  jhsy1: { grade: 10, subject: "HINB", offset: 14 },
};

/**
 * Books whose app titles were known to be wrong: the author's name stood in
 * for the lesson title. For these the book's title is WRITTEN, the same title
 * prisma/curriculum.ts now carries, instead of being checked against the old one.
 */
const RETITLE = new Set(["ihga1", "jhks1", "jhsp1"]);
const lessonTitle = (entry: { title: string; author?: string | null }) =>
  entry.title.trim() === "पद" && entry.author ? `पद (${entry.author})` : entry.title.trim();

const squash = (value: string) =>
  value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

async function main() {
  const commit = process.argv.includes("--commit");
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) throw new Error("PLATFORM_DATABASE_URL is not set — see .env.example.");
  const db = new PrismaClient({ datasources: { db: { url } } });

  const dir = path.join(import.meta.dirname, "..", "prisma", "chapter-contents");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  const updates: { id: string; label: string; title: string | null; contents: Prisma.InputJsonValue }[] = [];
  const errors: string[] = [];

  try {
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const target = BOOKS[data.book];
      if (!target) {
        errors.push(`${file}: book ${data.book} is not mapped to a subject`);
        continue;
      }
      const chapters = await db.chapter.findMany({
        where: { subject: { code: target.subject, grade: { number: target.grade, board: { code: "CBSE" } } } },
        select: { id: true, number: true, title: true },
      });
      const byNumber = new Map(chapters.map((chapter) => [chapter.number, chapter]));

      for (const entry of data.chapters) {
        const number = entry.bookChapter + target.offset;
        const chapter = byNumber.get(number);
        const label = `Class ${target.grade} ${target.subject} ch ${number}`;
        if (!chapter) {
          errors.push(`${label}: no such chapter`);
          continue;
        }
        const appTitle = squash(chapter.title);
        const bookTitle = squash(entry.title);
        const retitle = RETITLE.has(data.book) ? lessonTitle(entry) : null;
        if (!retitle && !appTitle.includes(bookTitle) && !bookTitle.includes(appTitle)) {
          errors.push(`${label}: app title "${chapter.title}" does not match book title "${entry.title}"`);
          continue;
        }
        const { bookChapter, ...rest } = entry;
        updates.push({
          id: chapter.id,
          label,
          title: retitle && retitle !== chapter.title ? retitle : null,
          contents: {
            version: 1,
            source: { book: data.book, bookTitle: data.bookTitle, chapter: bookChapter },
            ...rest,
          },
        });
      }
    }

    for (const update of updates) if (update.title) console.log(`  RETITLE ${update.label} -> ${update.title}`);
    for (const error of errors) console.log(`  ERROR ${error}`);
    console.log(`${updates.length} chapter(s) to write, ${errors.length} error(s).`);
    if (errors.length) {
      process.exitCode = 1;
      return;
    }
    if (!commit) {
      console.log("Dry run. Pass --commit to write.");
      return;
    }
    await db.$transaction(
      async (tx) => {
        for (const update of updates) {
          await tx.chapter.update({
            where: { id: update.id },
            data: { contents: update.contents, ...(update.title ? { title: update.title } : {}) },
          });
        }
      },
      { maxWait: 10_000, timeout: 300_000 },
    );
    console.log(`Wrote contents for ${updates.length} chapter(s).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
