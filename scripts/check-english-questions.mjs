/**
 * Checks prisma/english-questions/*.json — the written and competency questions
 * for CBSE Class 10 English — before anything is imported.
 *
 *     node scripts/check-english-questions.mjs --text .english-text
 *
 * `--text` is a directory of chapter text extracted from the NCERT PDFs, one
 * file per chapter named by its PDF (`jeff101.txt`). Produce it with
 *
 *     pdftotext -layout <NCERT>/public/ncert/jeff1/jeff101.pdf .english-text/jeff101.txt
 *
 * No database: this reads the files, the outcome drafts and the book text, so it
 * can run while the questions are being written.
 *
 * ---------------------------------------------------------------------------
 * The file format
 * ---------------------------------------------------------------------------
 * One file per book: { book, chapters: [{ number, questions: [...] }] }. Every
 * question has `id` (unique), `kind`, `outcome` (a code from that chapter in
 * prisma/curriculum-drafts), `difficulty` (EASY | MEDIUM | HARD) and `marks`.
 *
 *   kind "competency"  — MCQ, 1 mark. `stem`, `options: [{ text, correct }]`
 *                        (four, exactly one correct), `explanation`.
 *   kind "extract"     — reference to the context, 5 marks. `source` (prose |
 *                        drama | poem), `extract` (VERBATIM from the chapter),
 *                        `parts: [{ type: mcq | vsa | sa, prompt, marks,
 *                        options? (mcq), answer }]` summing to 5, at least one
 *                        mcq part.
 *   kind "short"       — SA, 3 marks, 40–50 words. `stem`, `valuePoints: []`,
 *                        `rubric: [{ label, marks, descriptor }]` summing to 3.
 *   kind "long"        — LA, 6 marks, 100–120 words, beyond the text.
 *                        `lifeSkill`, `stem`, `valuePoints: []`, `rubric`
 *                        summing to 6.
 *
 * ---------------------------------------------------------------------------
 * The pattern each chapter must hold
 * ---------------------------------------------------------------------------
 * 3 competency, 2 extract, 4 short, 2 long — the CBSE 2025-26 English (184)
 * question paper design: extracts of 5 marks with MCQ, one-sentence and 30–40
 * word parts; short answers of 3 marks in 40–50 words; long answers of 6 marks
 * in 100–120 words "beyond the text and across the text".
 *
 * ---------------------------------------------------------------------------
 * Why an extract is matched word by word, in order
 * ---------------------------------------------------------------------------
 * An extract is the one part of a question that claims to BE the book, and a
 * misremembered line — a word changed in a poem — is a question whose answer
 * is wrong. So every word of it must appear in the chapter, in order. It is not
 * matched as one string because the PDFs print a glossary in the margin, and
 * extraction splices "crest / top of a hill" into the middle of the sentence
 * beside it; up to MAX_GAP words may intervene between two words of an extract.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const textArg = args.indexOf("--text");
if (textArg === -1 || !args[textArg + 1]) {
  console.error("Pass --text <directory of extracted chapter text>.");
  process.exit(2);
}
const TEXT_DIR = args[textArg + 1];
// `--dir` checks a working directory instead, so a chapter can be checked
// while it is being written, before it joins the book file.
const dirArg = args.indexOf("--dir");
const QUESTIONS_DIR = dirArg !== -1 && args[dirArg + 1] ? args[dirArg + 1] : "prisma/english-questions";
const DRAFTS = {
  jeff1: "prisma/curriculum-drafts/cbse-10-english-first-flight.json",
  jefp1: "prisma/curriculum-drafts/cbse-10-english-footprints.json",
};
const PATTERN = { competency: 3, extract: 2, short: 4, long: 2 };
const MARKS = { competency: 1, extract: 5, short: 3, long: 6 };
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

/** Every word of `needle`, in order, with at most MAX_GAP words between. */
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

const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;

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
  if (!Array.isArray(options) || options.length !== 4) return fail(where, "needs exactly four options");
  const correct = options.filter((option) => option.correct === true).length;
  if (correct !== 1) fail(where, `needs exactly one correct option (has ${correct})`);
  const texts = options.map((option) => (option.text ?? "").trim().toLowerCase());
  if (texts.some((text) => !text)) fail(where, "an option has no text");
  if (new Set(texts).size !== texts.length) fail(where, "two options say the same thing");
  if (texts.some((text) => /^(all|none) of (the above|these)$/.test(text))) {
    warn(where, "avoid 'all/none of the above'");
  }
  return options.findIndex((option) => option.correct === true);
}

const files = fs.existsSync(QUESTIONS_DIR)
  ? fs.readdirSync(QUESTIONS_DIR).filter((file) => file.endsWith(".json"))
  : [];
if (files.length === 0) fail(QUESTIONS_DIR, "no question files");

const ids = new Set();
const totals = { questions: 0, chapters: 0 };

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, file), "utf8"));
  const book = data.book;
  if (!DRAFTS[book]) {
    fail(file, `unknown book "${book}"`);
    continue;
  }
  const drafts = JSON.parse(fs.readFileSync(DRAFTS[book], "utf8"));
  const correctPositions = [0, 0, 0, 0];

  for (const chapter of data.chapters ?? []) {
    const where = `${book} ch${chapter.number}`;
    totals.chapters++;
    const outcomes = new Set(
      (drafts.chapters.find((c) => c.number === chapter.number)?.topics ?? []).flatMap((topic) =>
        topic.outcomes.map((outcome) => outcome.code),
      ),
    );
    if (outcomes.size === 0) fail(where, "no outcomes in the curriculum draft for this chapter");

    const textFile = path.join(TEXT_DIR, `${book}${String(chapter.number).padStart(2, "0")}.txt`);
    const bookWords = fs.existsSync(textFile) ? words(fs.readFileSync(textFile, "utf8")) : null;
    if (!bookWords) fail(where, `no extracted text at ${textFile}`);

    const byKind = { competency: 0, extract: 0, short: 0, long: 0 };
    const extractSources = [];

    for (const question of chapter.questions ?? []) {
      const at = `${where} ${question.id ?? "(no id)"}`;
      totals.questions++;
      if (!question.id) fail(at, "no id");
      else if (ids.has(question.id)) fail(at, "duplicate id");
      ids.add(question.id);

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

      if (question.kind === "competency") {
        if (!(question.stem?.trim().length >= 10)) fail(at, "stem is missing or too short");
        const position = checkOptions(at, question.options);
        if (position >= 0) correctPositions[position]++;
        if (!question.explanation?.trim()) fail(at, "no explanation");
      }

      if (question.kind === "extract") {
        if (!["prose", "drama", "poem"].includes(question.source)) fail(at, "source must be prose, drama or poem");
        extractSources.push(question.source);
        const extractWords = words(question.extract ?? "");
        if (extractWords.length < 25) fail(at, "extract is too short to set five marks on");
        if (extractWords.length > 220) fail(at, `extract is ${extractWords.length} words; keep it under 220`);
        if (bookWords && !foundInOrder(extractWords, bookWords)) {
          fail(at, "extract is not in the chapter text word for word — copy it from the book");
        }
        const parts = question.parts ?? [];
        if (parts.length < 3 || parts.length > 6) fail(at, "an extract has 3 to 6 parts");
        const sum = parts.reduce((total, part) => total + (part.marks ?? 0), 0);
        if (sum !== 5) fail(at, `parts add to ${sum}, not 5`);
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
            if (position >= 0) correctPositions[position]++;
          }
        });
      }

      if (question.kind === "short" || question.kind === "long") {
        if (!(question.stem?.trim().length >= 10)) fail(at, "stem is missing or too short");
        if (!Array.isArray(question.valuePoints) || question.valuePoints.length < 2) {
          fail(at, "needs at least two value points for the marker");
        }
        checkRubric(at, question.rubric, question.marks);
        if (question.kind === "long" && !question.lifeSkill?.trim()) fail(at, "a long answer names its life skill");
        if (question.kind === "long" && countWords(question.stem) < 15) {
          warn(at, "a long answer usually sets a situation, not just a question");
        }
      }
    }

    for (const [kind, expected] of Object.entries(PATTERN)) {
      if (byKind[kind] !== expected) fail(where, `${byKind[kind]} ${kind} questions, the pattern is ${expected}`);
    }
    if (book === "jeff1" && !extractSources.some((source) => source !== "poem")) {
      fail(where, "a First Flight chapter needs a prose or drama extract");
    }
  }

  const answered = correctPositions.reduce((a, b) => a + b, 0);
  if (answered >= 12 && Math.max(...correctPositions) / answered > 0.4) {
    warn(file, `correct answers bunch in one position (${correctPositions.join("/")} across A-D)`);
  }
}

for (const message of warnings) console.log(`  warn   ${message}`);
for (const message of errors) console.log(`  ERROR  ${message}`);
console.log(`\n${totals.chapters} chapters, ${totals.questions} questions, ${errors.length} errors, ${warnings.length} warnings.`);
process.exitCode = errors.length ? 1 : 0;
