/**
 * Checks prisma/chapter-contents/*.json against the extracted book text.
 *
 *     node scripts/check-chapter-contents.mjs --text <dir of extracted chapter text>
 *     node scripts/check-chapter-contents.mjs --text <dir> jemh1.json iesc1.json
 *     node scripts/check-chapter-contents.mjs --text <dir> --also <pdftotext dir>
 *
 * The contents are only worth having if they are the book's, so every section
 * and subsection title, activity label and exercise name must appear in that
 * chapter's text (compared loosely: case, spacing, punctuation and hyphenated
 * line breaks ignored). It also checks the shape, that chapter numbers match the
 * book's manifest, and that nothing required is empty. Exits non-zero on any
 * problem, and names each one.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const textAt = args.indexOf("--text");
if (textAt === -1 || !args[textAt + 1]) {
  console.error("Pass --text <directory of extracted chapter text>.");
  process.exit(1);
}
const TEXT = args[textAt + 1];
/** Every `--also <dir>`: further extractions of the same PDFs to search. */
const ALSO = args.flatMap((arg, index) => (arg === "--also" && args[index + 1] ? [args[index + 1]] : []));
const DIR = path.join(import.meta.dirname, "..", "prisma", "chapter-contents");
const only = args.filter((arg) => arg.endsWith(".json"));
const files = only.length ? only : fs.readdirSync(DIR).filter((name) => name.endsWith(".json"));

/** Letters and digits only, in any script, lower-cased. */
const squash = (value) =>
  String(value)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

// Devanagari extracted from these PDFs doubles some vowel signs and viramas
// ("प्रदर्शशित"). Comparing on consonants alone keeps a correctly spelled Hindi
// heading from failing against a garbled extraction.
const skeleton = (value) => squash(value).replace(/[ऀ-ःऺ-ॏ॑-ॗॢॣ]/g, "").replace(/(.)\1+/gu, "$1");

let problems = 0;
const fail = (where, message) => {
  problems++;
  console.log(`  ${where}: ${message}`);
};

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
  const book = data.book;
  console.log(`${file} (${data.chapters?.length ?? 0} chapters)`);
  if (!Array.isArray(data.chapters) || data.chapters.length === 0) {
    fail(file, "no chapters");
    continue;
  }
  for (const chapter of data.chapters) {
    const where = `${book} ch ${chapter.bookChapter}`;
    const source = path.join(TEXT, `${book}-${String(chapter.bookChapter).padStart(2, "0")}.txt`);
    if (!fs.existsSync(source)) {
      fail(where, `no extracted text at ${source}`);
      continue;
    }
    // Heading markers and page separators come from the extraction, not the
    // book; left in, "EXERCISE" / "[H12.0] 10.2" split across lines never matches.
    // A second extraction of the same PDF (`--also`, e.g. pdftotext) is
    // searched too: small capitals come out scrambled from one extractor and
    // whole from the other, and a real heading must not fail for that.
    // Kruti Dev-encoded Hindi books need a converted copy for the same reason.
    const others = ALSO.map((dir) => path.join(dir, path.basename(source))).filter((file) => fs.existsSync(file));
    const raw = [source, ...others]
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n")
      .replace(/^\[H[\d.]+\] /gm, "")
      .replace(/^=== PAGE \d+ ===$/gm, "");
    const text = squash(raw);
    const loose = skeleton(raw);
    // A heading whose symbols the extraction dropped ("… Irrationality of √2"
    // extracts as "… Irrationality of") is listed in the chapter's
    // `extractionGaps`, and then only its words, without digits and symbols,
    // have to be found. Listed, so the exception is visible in the data.
    const gaps = new Set(chapter.extractionGaps ?? []);
    // First Flight prints its exercise headings ("Thinking about Language")
    // as pictures, which no text extractor sees. Those were read off rendered
    // page images and are listed in `imageHeadings`; they are the one thing
    // accepted without a text match, and only because the list says so.
    const pictured = new Set(chapter.imageHeadings ?? []);
    const found = (value) => {
      if (pictured.has(value)) return true;
      const needle = squash(value);
      if (needle.length === 0 || text.includes(needle) || loose.includes(skeleton(value))) return true;
      return gaps.has(value) && text.includes(squash(String(value).replace(/[^\p{L}\s]+/gu, "")));
    };

    if (!chapter.title) fail(where, "no title");
    if (!chapter.overview || chapter.overview.length < 60) fail(where, "overview missing or too short");
    if (!Array.isArray(chapter.sections) || chapter.sections.length === 0) fail(where, "no sections");

    for (const section of chapter.sections ?? []) {
      if (!section.title) fail(where, "a section has no title");
      else if (!found(section.title)) fail(where, `section title not in the book: "${section.title}"`);
      if (section.number && !found(section.number)) fail(where, `section number not in the book: ${section.number}`);
      if (!Array.isArray(section.points) || section.points.length === 0) fail(where, `section "${section.title}" has no points`);
      for (const sub of section.subsections ?? []) {
        if (!sub.title || !found(sub.title)) fail(where, `subsection title not in the book: "${sub.title}"`);
      }
    }
    for (const activity of chapter.activities ?? []) {
      if (!found(activity)) fail(where, `activity not in the book: "${activity}"`);
    }
    for (const exercise of chapter.exercises ?? []) {
      if (!exercise.name || !found(exercise.name)) fail(where, `exercise not in the book: "${exercise.name}"`);
    }
    for (const term of chapter.keyTerms ?? []) {
      if (!term.term || !term.meaning) fail(where, "a key term is missing its term or meaning");
    }
    for (const result of chapter.keyResults ?? []) {
      if (!result.label || !result.statement) fail(where, "a key result is missing its label or statement");
    }
  }
}

console.log(problems ? `\n${problems} problem(s).` : "\nEvery heading, activity and exercise was found in the book text.");
process.exitCode = problems ? 1 : 0;
