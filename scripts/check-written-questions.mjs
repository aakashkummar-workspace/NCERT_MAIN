/**
 * Checks prisma/written-questions/*.json — assertion–reason, very short, short,
 * long and case-based questions for CBSE Class 9 and 10 Mathematics, Science
 * and Social Science — before anything is imported.
 *
 *     node scripts/check-written-questions.mjs --text .ncert-text
 *     node scripts/check-written-questions.mjs --text .ncert-text --dir .written-work --only jemh1:1-7
 *
 * `--text` is chapter text extracted from the NCERT PDFs (`jemh101.txt`), used
 * only for a case passage marked `fromBook`. `--dir` adds more question files,
 * and a chapter's questions may be split across files; `--only` limits the
 * report to some chapters while others are still being written.
 *
 * ---------------------------------------------------------------------------
 * The pattern, per chapter
 * ---------------------------------------------------------------------------
 * The CBSE 2025-26 sample-paper typology for these subjects: 1-mark
 * assertion–reason, 2-mark very short answers, 3-mark short answers, 5-mark
 * long answers and 4-mark case/source-based questions. Multiple-choice items
 * are already in the bank, so every chapter here carries
 *
 *     2 ar, 3 vsa, 3 sa, 2 la, 1 case
 *
 *   kind "ar"    — 1 mark. `assertion`, `reason`, `answer` a | b | c | d on the
 *                  standard CBSE key (a: both true and R explains A; b: both
 *                  true, R does not explain A; c: A true, R false; d: A false,
 *                  R true), `explanation`.
 *   kind "vsa"   — 2 marks. `stem`, `answer` (model answer or worked
 *                  solution), `valuePoints`, `rubric` summing to 2.
 *   kind "sa"    — 3 marks, the same shape, rubric summing to 3.
 *   kind "la"    — 5 marks, the same shape, rubric summing to 5.
 *   kind "case"  — 4 marks. `passage` (the case: a situation, data or a source
 *                  extract; `fromBook: true` when it is quoted from the book,
 *                  which then must match the chapter text word for word),
 *                  `parts: [{ type: mcq | vsa | sa, prompt, marks, options?,
 *                  answer }]` summing to 4, at least one mcq part.
 *
 * A rubric is `[{ label, marks, descriptor }]`: labels unique, marks in
 * halves, at most eight. Every question has `id`, `kind`, `outcome` (a code of
 * its own chapter), `difficulty` and `marks`.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const valuesOf = (flag) => args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]] : []));

const TEXT_DIR = valuesOf("--text")[0];
if (!TEXT_DIR) {
  console.error("Pass --text <directory of extracted chapter text>.");
  process.exit(2);
}
const QUESTION_DIRS = ["prisma/written-questions", ...valuesOf("--dir")];
const ONLY = valuesOf("--only").map((spec) => {
  const [book, range = ""] = spec.split(":");
  const [from, to] = range.split("-").map(Number);
  return { book, from: from || 1, to: to || from || 99 };
});
const inScope = (book, number) =>
  ONLY.length === 0 || ONLY.some((only) => only.book === book && number >= only.from && number <= only.to);

/**
 * Each NCERT book, its outcome draft, and the chapters CBSE does not examine in
 * the board paper: History ch4 is periodic assessment only, and Geography ch7
 * is assessed by map pointing alone (CBSE Social Science syllabus 2025-26).
 */
export const BOOKS = {
  jemh1: { grade: 10, subject: "MATH", draft: "cbse-10-mathematics", skip: [] },
  jesc1: { grade: 10, subject: "SCI", draft: "cbse-10-science", skip: [] },
  jess1: { grade: 10, subject: "SST", draft: "cbse-10-sst-geography", skip: [7] },
  jess2: { grade: 10, subject: "SSTEC", draft: "cbse-10-sst-economics", skip: [] },
  jess3: { grade: 10, subject: "SSTHI", draft: "cbse-10-sst-history", skip: [4] },
  jess4: { grade: 10, subject: "SSTPS", draft: "cbse-10-sst-political-science", skip: [] },
  iemh1: { grade: 9, subject: "MATH", draft: "cbse-9-mathematics", skip: [] },
  iesc1: { grade: 9, subject: "SCI", draft: "cbse-9-science", skip: [] },
  iest1: { grade: 9, subject: "SST", draft: "cbse-9-social-science", skip: [] },
};

/** Class 10 Maths ch6 is the seeded worked example, not in a draft file. */
const EXTRA_OUTCOMES = { "jemh1:6": ["SIM-1", "SIM-2", "SIM-3", "SIM-4"] };

const PATTERN = { ar: 2, vsa: 3, sa: 3, la: 2, case: 1 };
const MARKS = { ar: 1, vsa: 2, sa: 3, la: 5, case: 4 };
const MAX_GAP = 12;

const errors = [];
const warnings = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);
const warn = (where, message) => warnings.push(`${where}: ${message}`);

const words = (text) =>
  text
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/-{2,}|[—–]/g, " ")
    .split(/[^a-z0-9']+/)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter(Boolean);

function foundInOrder(needle, haystack) {
  if (needle.length === 0) return false;
  for (let start = 0; start < haystack.length; start++) {
    if (haystack[start] !== needle[0]) continue;
    let at = start;
    let ok = true;
    for (let i = 1; i < needle.length; i++) {
      let next = -1;
      for (let j = at + 1; j <= at + 1 + MAX_GAP && j < haystack.length; j++) {
        if (haystack[j] === needle[i]) {
          next = j;
          break;
        }
      }
      if (next === -1) {
        ok = false;
        break;
      }
      at = next;
    }
    if (ok) return true;
  }
  return false;
}

function checkRubric(where, rubric, marks) {
  if (!Array.isArray(rubric) || rubric.length === 0) return fail(where, "no rubric");
  if (rubric.length > 8) fail(where, "a rubric has at most 8 criteria");
  const labels = new Set();
  let total = 0;
  for (const criterion of rubric) {
    if (!criterion.label?.trim()) fail(where, "a rubric criterion has no label");
    if (labels.has(criterion.label)) fail(where, `rubric label "${criterion.label}" repeats`);
    labels.add(criterion.label);
    if (!(criterion.marks > 0) || (criterion.marks * 2) % 1 !== 0) {
      fail(where, `rubric marks must be positive halves (got ${criterion.marks})`);
    }
    total += criterion.marks;
  }
  if (Math.abs(total - marks) > 1e-9) fail(where, `rubric adds to ${total}, question is worth ${marks}`);
}

function checkOptions(where, options) {
  if (!Array.isArray(options) || options.length !== 4) {
    fail(where, "needs exactly four options");
    return -1;
  }
  const correct = options.filter((option) => option.correct === true).length;
  if (correct !== 1) fail(where, `needs exactly one correct option (has ${correct})`);
  const texts = options.map((option) => String(option.text ?? "").trim().toLowerCase());
  if (texts.some((text) => !text)) fail(where, "an option has no text");
  if (new Set(texts).size !== texts.length) fail(where, "two options say the same thing");
  return options.findIndex((option) => option.correct === true);
}

// ---- Gather every question by book and chapter -----------------------------
const chapters = new Map();
let fileCount = 0;
for (const dir of QUESTION_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    fileCount++;
    const where = path.join(dir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(where, "utf8"));
    } catch (error) {
      fail(where, `not valid JSON: ${error.message}`);
      continue;
    }
    if (!BOOKS[data.book]) {
      fail(where, `unknown book "${data.book}"`);
      continue;
    }
    for (const chapter of data.chapters ?? []) {
      const key = `${data.book}:${chapter.number}`;
      const entry = chapters.get(key) ?? { book: data.book, number: chapter.number, questions: [] };
      entry.questions.push(...(chapter.questions ?? []));
      chapters.set(key, entry);
    }
  }
}
if (fileCount === 0) fail(QUESTION_DIRS.join(", "), "no question files");

const draftCache = {};
const draftFor = (book) =>
  (draftCache[book] ??= JSON.parse(fs.readFileSync(`prisma/curriculum-drafts/${BOOKS[book].draft}.json`, "utf8")));
const ids = new Set();
const totals = { questions: 0, chapters: 0 };
const arAnswers = {};
const positions = {};

for (const { book, number, questions } of [...chapters.values()].sort((a, b) => a.book.localeCompare(b.book) || a.number - b.number)) {
  for (const question of questions) {
    if (question.id && ids.has(question.id)) fail(`${book} ch${number} ${question.id}`, "duplicate id");
    if (question.id) ids.add(question.id);
  }
  if (!inScope(book, number)) continue;

  const where = `${book} ch${number}`;
  totals.chapters++;
  if (BOOKS[book].skip.includes(number)) fail(where, "this chapter is not examined in the board paper; set nothing on it");
  const draftChapter = draftFor(book).chapters.find((c) => c.number === number);
  const outcomes = new Set([
    ...(draftChapter?.topics ?? []).flatMap((topic) => topic.outcomes.map((o) => o.code)),
    ...(EXTRA_OUTCOMES[`${book}:${number}`] ?? []),
  ]);
  if (outcomes.size === 0) fail(where, "no outcomes for this chapter");
  // Both extractions of the chapter: the two-column Social Science books come
  // out of the layout extractor with the columns interleaved, so a passage that
  // IS in the book does not match in order there — the plain extraction keeps
  // reading order. A passage found in either is quoted from the book.
  const textFiles = [
    path.join(TEXT_DIR, `${book}${String(number).padStart(2, "0")}.txt`),
    path.join(TEXT_DIR, "plain", `${book}${String(number).padStart(2, "0")}.txt`),
  ].filter((file) => fs.existsSync(file));
  const extractions = textFiles.map((file) => words(fs.readFileSync(file, "utf8")));

  const byKind = { ar: 0, vsa: 0, sa: 0, la: 0, case: 0 };
  const correct = (positions[book] ??= [0, 0, 0, 0]);
  const ar = (arAnswers[book] ??= { a: 0, b: 0, c: 0, d: 0 });

  for (const question of questions) {
    const at = `${where} ${question.id ?? "(no id)"}`;
    totals.questions++;
    if (!question.id) fail(at, "no id");
    if (!(question.kind in PATTERN)) {
      fail(at, `unknown kind "${question.kind}"`);
      continue;
    }
    byKind[question.kind]++;
    if (question.marks !== MARKS[question.kind]) {
      fail(at, `${question.kind} is worth ${MARKS[question.kind]} marks (got ${question.marks})`);
    }
    if (!outcomes.has(question.outcome)) fail(at, `outcome "${question.outcome}" is not in this chapter`);
    if (!["EASY", "MEDIUM", "HARD"].includes(question.difficulty)) fail(at, "difficulty must be EASY, MEDIUM or HARD");

    if (question.kind === "ar") {
      if (!(question.assertion?.trim().length >= 10)) fail(at, "no assertion");
      if (!(question.reason?.trim().length >= 10)) fail(at, "no reason");
      if (!["a", "b", "c", "d"].includes(question.answer)) fail(at, "answer must be a, b, c or d");
      else ar[question.answer]++;
      if (!question.explanation?.trim()) fail(at, "no explanation");
    }

    if (question.kind === "vsa" || question.kind === "sa" || question.kind === "la") {
      if (!(question.stem?.trim().length >= 10)) fail(at, "stem is missing or too short");
      if (!question.answer?.trim()) fail(at, "no model answer or worked solution");
      if (!Array.isArray(question.valuePoints) || question.valuePoints.length < 2) {
        fail(at, "needs at least two value points for the marker");
      }
      checkRubric(at, question.rubric, question.marks);
    }

    if (question.kind === "case") {
      const passageWords = words(question.passage ?? "");
      if (passageWords.length < 40) fail(at, "a case passage needs at least 40 words to set four marks on");
      if (passageWords.length > 300) fail(at, `passage is ${passageWords.length} words; keep it under 300`);
      if (question.fromBook) {
        if (extractions.length === 0) fail(at, `fromBook, but no extracted text for ${book} ch${number}`);
        else if (!extractions.some((haystack) => foundInOrder(passageWords, haystack))) {
          fail(at, "marked fromBook, but the passage is not in the chapter text word for word");
        }
      }
      const parts = question.parts ?? [];
      if (parts.length < 3 || parts.length > 5) fail(at, "a case question has 3 to 5 parts");
      const sum = parts.reduce((total, part) => total + (part.marks ?? 0), 0);
      if (sum !== 4) fail(at, `parts add to ${sum}, not 4`);
      if (!parts.some((part) => part.type === "mcq")) fail(at, "needs at least one mcq part");
      parts.forEach((part, index) => {
        const partAt = `${at} part ${index + 1}`;
        if (!["mcq", "vsa", "sa"].includes(part.type)) fail(partAt, "type must be mcq, vsa or sa");
        if (!part.prompt?.trim()) fail(partAt, "no prompt");
        if (!part.answer?.trim()) fail(partAt, "no answer");
        if (!Number.isInteger(part.marks) || part.marks < 1) fail(partAt, "marks must be a whole number");
        if (part.type === "mcq") {
          if (part.marks !== 1) fail(partAt, "an mcq part is worth 1 mark");
          const position = checkOptions(partAt, part.options);
          if (position >= 0) correct[position]++;
        }
      });
    }
  }

  for (const [kind, expected] of Object.entries(PATTERN)) {
    if (byKind[kind] !== expected) fail(where, `${byKind[kind]} ${kind} questions, the pattern is ${expected}`);
  }
}

for (const [book, counts] of Object.entries(arAnswers)) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total >= 8 && Math.max(...Object.values(counts)) / total > 0.5) {
    warn(book, `assertion–reason answers bunch on one key (${JSON.stringify(counts)})`);
  }
}

for (const message of warnings) console.log(`  warn   ${message}`);
for (const message of errors) console.log(`  ERROR  ${message}`);
console.log(`\n${totals.chapters} chapters, ${totals.questions} questions, ${errors.length} errors, ${warnings.length} warnings.`);
process.exitCode = errors.length ? 1 : 0;
