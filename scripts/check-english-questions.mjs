/**
 * Checks prisma/english-questions/*.json — the written and competency questions
 * for CBSE Class 9 and 10 English — before anything is imported.
 *
 *     node scripts/check-english-questions.mjs --text .english-text
 *
 * `--text` is a directory of chapter text extracted from the NCERT PDFs, one
 * file per chapter named by its PDF (`jeff101.txt`). Produce it with
 *
 *     pdftotext -layout <NCERT>/public/ncert/jeff1/jeff101.pdf .english-text/jeff101.txt
 *
 * `--dir` (repeatable) reads question files from other directories as well,
 * and a chapter's questions may be split across files: they are gathered by
 * book and chapter before anything is counted. `--only jeff1:1-3` limits the
 * report to those chapters, so a chapter can be checked while others are
 * still being written.
 *
 * No database: this reads the files, the outcome drafts and the book text.
 *
 * ---------------------------------------------------------------------------
 * The file format
 * ---------------------------------------------------------------------------
 * One file per book (or per batch): { book, chapters: [{ number, questions }] }.
 * Every question has `id` (unique), `kind`, `outcome` (a code from that
 * chapter in prisma/curriculum-drafts), `difficulty` (EASY | MEDIUM | HARD)
 * and `marks`.
 *
 *   kind "competency"  — MCQ, 1 mark. `stem`, `options: [{ text, correct }]`
 *                        (four, exactly one correct), `explanation`.
 *   kind "extract"     — reference to the context, 5 marks. `source` (prose |
 *                        drama | poem), `poem` (its title, for a poem),
 *                        `extract` (VERBATIM from the chapter), `parts: [{
 *                        type: mcq | vsa | sa, prompt, marks, options? (mcq),
 *                        answer }]` summing to 5, at least one mcq part.
 *   kind "short"       — SA, 3 marks, 40–50 words. `stem`, `valuePoints: []`,
 *                        `rubric: [{ label, marks, descriptor }]` summing to 3.
 *   kind "long"        — LA, 6 marks, 100–120 words, beyond the text.
 *                        `lifeSkill`, `stem`, `valuePoints: []`, `rubric`
 *                        summing to 6.
 *
 * ---------------------------------------------------------------------------
 * The pattern each chapter must hold
 * ---------------------------------------------------------------------------
 * 5 competency, 6 short, 3 long in every chapter; and extracts —
 *   First Flight and Kaveri: 2 from the prose or play, and 2 from EACH poem
 *   the chapter carries (1 for a poem too short to set two on).
 *   Footprints without Feet: 3 from the story or play.
 * Grammar and writing (books gw10, gw9 — the subject English – Grammar and
 * Writing, whose chapters are syllabus items rather than book chapters): 20
 * `grammar` questions in each grammar chapter (1–5) and 8 `writing` tasks in
 * each writing chapter (6–7). They quote no book, so no text is matched.
 *
 *   kind "grammar"     — MCQ, 1 mark. `task` (gap-filling | editing |
 *                        transformation), `stem`, four `options`, one correct,
 *                        `explanation` naming the rule.
 *   kind "writing"     — 5 marks, 100–120 words. `form` (formal-letter |
 *                        analytical-paragraph | descriptive-paragraph | story |
 *                        diary-entry), `stem` carrying the full situation or
 *                        data, `valuePoints`, `rubric` summing to 5.
 *
 * Reading comprehension (chapter 8 of gw10 and gw9): 16 `reading` questions —
 * 8 `discursive` passages of 400–450 words and 8 `factual` case-based passages
 * of 200–250 words carrying a table or chart in words, as CBSE Section A sets
 * them.
 *
 *   kind "reading"     — 10 marks. `passageType` (discursive | factual),
 *                        `title`, `passage`, `parts` (mcq 1 mark with four
 *                        options, vsa 1 mark, sa 2 marks, each with `answer`)
 *                        summing to 10, at least four mcq parts.
 *
 * The marks are the CBSE English (184) paper design: extracts of 5 with MCQ,
 * one-sentence and 30–40 word parts; short answers of 3 in 40–50 words; long
 * answers of 6 in 100–120 words "beyond the text and across the text".
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
const valuesOf = (flag) => args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]] : []));

const TEXT_DIR = valuesOf("--text")[0];
if (!TEXT_DIR) {
  console.error("Pass --text <directory of extracted chapter text>.");
  process.exit(2);
}
const QUESTION_DIRS = ["prisma/english-questions", ...valuesOf("--dir")];
const ONLY = valuesOf("--only").map((spec) => {
  const [book, range = ""] = spec.split(":");
  const [from, to] = range.split("-").map(Number);
  return { book, from: from || 1, to: to || from || 99 };
});
const inScope = (book, number) =>
  ONLY.length === 0 || ONLY.some((only) => only.book === book && number >= only.from && number <= only.to);

const DRAFTS = {
  jeff1: "prisma/curriculum-drafts/cbse-10-english-first-flight.json",
  jefp1: "prisma/curriculum-drafts/cbse-10-english-footprints.json",
  iebe1: "prisma/curriculum-drafts/cbse-9-english.json",
  gw10: "prisma/curriculum-drafts/cbse-10-english-grammar-writing.json",
  gw9: "prisma/curriculum-drafts/cbse-9-english-grammar-writing.json",
};
const GRAMMAR_BOOKS = new Set(["gw10", "gw9"]);
const GRAMMAR_TASKS = new Set(["gap-filling", "editing", "transformation"]);
const WRITING_FORMS = {
  gw10: new Set(["formal-letter", "analytical-paragraph"]),
  gw9: new Set(["descriptive-paragraph", "story", "diary-entry"]),
};

/**
 * The CBSE 2025-26 syllabus poems bound into each First Flight chapter. 'Animals'
 * is printed in the book and was removed from the syllabus, so it is absent.
 */
const FIRST_FLIGHT_POEMS = {
  1: ["Dust of Snow", "Fire and Ice"],
  2: ["A Tiger in the Zoo"],
  3: ["How to Tell Wild Animals", "The Ball Poem"],
  4: ["Amanda!"],
  5: ["The Trees"],
  6: ["Fog"],
  7: ["The Tale of Custard the Dragon"],
  8: ["For Anne Gregory"],
  9: [],
};
/** Poems too short to carry two different five-mark extracts. */
const ONE_EXTRACT_POEMS = new Set(["Fog", "Dust of Snow"]);

const COUNTS = { competency: 5, short: 6, long: 3 };
const MARKS = { competency: 1, extract: 5, short: 3, long: 6, grammar: 1, writing: 5, reading: 10 };
/** CBSE's passage lengths, with a little room either side. */
const PASSAGE_WORDS = { discursive: [380, 470], factual: [180, 270] };
/** The app refuses a stem over 4,000 characters; the whole case question must fit. */
const STEM_LIMIT = 3900;
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
  if (!Array.isArray(options) || options.length !== 4) {
    fail(where, "needs exactly four options");
    return -1;
  }
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

/** The poems a chapter carries: listed for First Flight, named in Kaveri's outcomes. */
function poemsFor(book, number, draftChapter) {
  if (book === "jeff1") return FIRST_FLIGHT_POEMS[number] ?? [];
  if (book === "iebe1") {
    const statements = (draftChapter?.topics ?? []).flatMap((topic) => topic.outcomes.map((o) => o.statement));
    const titles = statements.flatMap((statement) =>
      /\bpoe[mt]\b/.test(statement) ? [...statement.matchAll(/(?:poem|in) '([^']+)'/g)].map((m) => m[1]) : [],
    );
    return [...new Set(titles)];
  }
  return [];
}

// ---- Gather every question by book and chapter, across files and dirs ------
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
    if (!DRAFTS[data.book]) {
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
const draftFor = (book) => (draftCache[book] ??= JSON.parse(fs.readFileSync(DRAFTS[book], "utf8")));
const ids = new Map();
const totals = { questions: 0, chapters: 0 };
const positions = {};

for (const { book, number, questions } of [...chapters.values()].sort((a, b) => a.book.localeCompare(b.book) || a.number - b.number)) {
  for (const question of questions) {
    if (!question.id) continue;
    if (ids.has(question.id)) fail(`${book} ch${number} ${question.id}`, "duplicate id");
    ids.set(question.id, true);
  }
  if (!inScope(book, number)) continue;

  const where = `${book} ch${number}`;
  totals.chapters++;
  if (GRAMMAR_BOOKS.has(book)) {
    checkGrammarChapter(book, number, where, questions);
    continue;
  }
  const draftChapter = draftFor(book).chapters.find((c) => c.number === number);
  const outcomes = new Set((draftChapter?.topics ?? []).flatMap((topic) => topic.outcomes.map((o) => o.code)));
  if (outcomes.size === 0) fail(where, "no outcomes in the curriculum draft for this chapter");
  const poems = poemsFor(book, number, draftChapter);

  const textFile = path.join(TEXT_DIR, `${book}${String(number).padStart(2, "0")}.txt`);
  const bookWords = fs.existsSync(textFile) ? words(fs.readFileSync(textFile, "utf8")) : null;
  if (!bookWords) fail(where, `no extracted text at ${textFile}`);

  const byKind = { competency: 0, short: 0, long: 0 };
  let proseExtracts = 0;
  const poemExtracts = {};
  const correct = (positions[book] ??= [0, 0, 0, 0]);

  for (const question of questions) {
    const at = `${where} ${question.id ?? "(no id)"}`;
    totals.questions++;
    if (!question.id) fail(at, "no id");

    if (!(question.kind in MARKS)) {
      fail(at, `unknown kind "${question.kind}"`);
      continue;
    }
    if (question.kind in byKind) byKind[question.kind]++;
    if (question.marks !== MARKS[question.kind]) {
      fail(at, `${question.kind} is worth ${MARKS[question.kind]} marks (got ${question.marks})`);
    }
    if (!outcomes.has(question.outcome)) fail(at, `outcome "${question.outcome}" is not in this chapter`);
    if (!["EASY", "MEDIUM", "HARD"].includes(question.difficulty)) fail(at, "difficulty must be EASY, MEDIUM or HARD");

    if (question.kind === "competency") {
      if (!(question.stem?.trim().length >= 10)) fail(at, "stem is missing or too short");
      const position = checkOptions(at, question.options);
      if (position >= 0) correct[position]++;
      if (!question.explanation?.trim()) fail(at, "no explanation");
    }

    if (question.kind === "extract") {
      if (!["prose", "drama", "poem"].includes(question.source)) fail(at, "source must be prose, drama or poem");
      if (question.source === "poem") {
        if (!poems.includes(question.poem)) {
          fail(at, `a poem extract names its poem, one of: ${poems.length ? poems.join(", ") : "(this chapter has no syllabus poem)"}`);
        } else {
          poemExtracts[question.poem] = (poemExtracts[question.poem] ?? 0) + 1;
        }
      } else {
        proseExtracts++;
      }
      const extractWords = words(question.extract ?? "");
      const minimum = question.source === "poem" ? 18 : 25;
      if (extractWords.length < minimum) fail(at, "extract is too short to set five marks on");
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
          if (position >= 0) correct[position]++;
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

  for (const [kind, expected] of Object.entries(COUNTS)) {
    if (byKind[kind] !== expected) fail(where, `${byKind[kind]} ${kind} questions, the pattern is ${expected}`);
  }
  const proseExpected = book === "jefp1" ? 3 : 2;
  if (proseExtracts !== proseExpected) {
    fail(where, `${proseExtracts} prose/drama extracts, the pattern is ${proseExpected}`);
  }
  for (const poem of poems) {
    const expected = ONE_EXTRACT_POEMS.has(poem) ? 1 : 2;
    if ((poemExtracts[poem] ?? 0) !== expected) {
      fail(where, `${poemExtracts[poem] ?? 0} extracts on '${poem}', the pattern is ${expected}`);
    }
  }
}

function checkGrammarChapter(book, number, where, questions) {
  const draftChapter = draftFor(book).chapters.find((c) => c.number === number);
  const outcomes = new Set((draftChapter?.topics ?? []).flatMap((topic) => topic.outcomes.map((o) => o.code)));
  if (outcomes.size === 0) fail(where, "no outcomes in the curriculum draft for this chapter");
  const kind = number <= 5 ? "grammar" : number <= 7 ? "writing" : "reading";
  const expected = kind === "grammar" ? 20 : kind === "writing" ? 8 : 16;
  const passageTypes = { discursive: 0, factual: 0 };
  const correct = (positions[book] ??= [0, 0, 0, 0]);
  const tasks = {};
  let count = 0;

  for (const question of questions) {
    const at = `${where} ${question.id ?? "(no id)"}`;
    totals.questions++;
    if (!question.id) fail(at, "no id");
    if (question.kind !== kind) {
      fail(at, `chapter ${number} holds ${kind} questions, not "${question.kind}"`);
      continue;
    }
    count++;
    if (question.marks !== MARKS[kind]) fail(at, `${kind} is worth ${MARKS[kind]} marks (got ${question.marks})`);
    if (!outcomes.has(question.outcome)) fail(at, `outcome "${question.outcome}" is not in this chapter`);
    if (!["EASY", "MEDIUM", "HARD"].includes(question.difficulty)) fail(at, "difficulty must be EASY, MEDIUM or HARD");
    if (kind !== "reading" && !(question.stem?.trim().length >= 10)) fail(at, "stem is missing or too short");

    if (kind === "reading") {
      checkReading(at, question, correct);
      if (question.passageType in passageTypes) passageTypes[question.passageType]++;
      continue;
    }

    if (kind === "grammar") {
      if (!GRAMMAR_TASKS.has(question.task)) fail(at, "task must be gap-filling, editing or transformation");
      tasks[question.task] = (tasks[question.task] ?? 0) + 1;
      const position = checkOptions(at, question.options);
      if (position >= 0) correct[position]++;
      if (!question.explanation?.trim()) fail(at, "no explanation");
    } else {
      if (!WRITING_FORMS[book].has(question.form)) {
        fail(at, `form must be one of ${[...WRITING_FORMS[book]].join(", ")}`);
      }
      if (countWords(question.stem) < 25) fail(at, "a writing task sets out the full situation or data");
      if (!Array.isArray(question.valuePoints) || question.valuePoints.length < 3) {
        fail(at, "needs at least three value points for the marker");
      }
      checkRubric(at, question.rubric, 5);
    }
  }

  if (count !== expected) fail(where, `${count} ${kind} questions, the pattern is ${expected}`);
  if (kind === "reading") {
    for (const [type, n] of Object.entries(passageTypes)) {
      if (n !== 8) fail(where, `${n} ${type} passages, the pattern is 8`);
    }
  }
  if (kind === "grammar") {
    for (const task of GRAMMAR_TASKS) {
      if (!(tasks[task] >= 4)) fail(where, `only ${tasks[task] ?? 0} ${task} questions; set at least 4 of each task`);
    }
  }
}

function checkReading(at, question, correct) {
  if (!["discursive", "factual"].includes(question.passageType)) {
    return fail(at, "passageType must be discursive or factual");
  }
  if (!question.title?.trim()) fail(at, "a passage needs a title");
  const passage = question.passage ?? "";
  const length = countWords(passage);
  const [min, max] = PASSAGE_WORDS[question.passageType];
  if (length < min || length > max) fail(at, `${question.passageType} passage is ${length} words; CBSE sets ${min + 20}–${max - 20}`);
  if (question.passageType === "factual" && (passage.match(/\d[\d,.]*/g) ?? []).length < 6) {
    fail(at, "a case-based factual passage carries its data — a table or chart written out with its figures");
  }
  const parts = question.parts ?? [];
  if (parts.length < 5 || parts.length > 8) fail(at, "a reading passage has 5 to 8 parts");
  const sum = parts.reduce((total, part) => total + (part.marks ?? 0), 0);
  if (sum !== 10) fail(at, `parts add to ${sum}, not 10`);
  if (parts.filter((part) => part.type === "mcq").length < 4) fail(at, "needs at least four mcq parts");
  let stemLength = passage.length + 80;
  parts.forEach((part, index) => {
    const partAt = `${at} part ${index + 1}`;
    if (!["mcq", "vsa", "sa"].includes(part.type)) fail(partAt, "type must be mcq, vsa or sa");
    if (!part.prompt?.trim()) fail(partAt, "no prompt");
    if (!part.answer?.trim()) fail(partAt, "no answer");
    const expectedMarks = part.type === "sa" ? 2 : 1;
    if (part.marks !== expectedMarks) fail(partAt, `${part.type} parts are worth ${expectedMarks}`);
    stemLength += (part.prompt ?? "").length + 20;
    if (part.type === "mcq") {
      const position = checkOptions(partAt, part.options);
      if (position >= 0) correct[position]++;
      stemLength += (part.options ?? []).reduce((total, option) => total + String(option.text ?? "").length + 12, 0);
    }
  });
  if (stemLength > STEM_LIMIT) fail(at, `the whole question would be about ${stemLength} characters; the app's limit is 4,000 — shorten the passage or the options`);
}

for (const [book, counts] of Object.entries(positions)) {
  const answered = counts.reduce((a, b) => a + b, 0);
  if (answered >= 12 && Math.max(...counts) / answered > 0.4) {
    warn(book, `correct answers bunch in one position (${counts.join("/")} across A-D)`);
  }
}

for (const message of warnings) console.log(`  warn   ${message}`);
for (const message of errors) console.log(`  ERROR  ${message}`);
console.log(`\n${totals.chapters} chapters, ${totals.questions} questions, ${errors.length} errors, ${warnings.length} warnings.`);
process.exitCode = errors.length ? 1 : 0;
