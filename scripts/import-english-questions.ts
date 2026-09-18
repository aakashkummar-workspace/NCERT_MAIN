/**
 * Import the CBSE Class 9 and 10 English competency, extract, short and long answer
 * questions (prisma/english-questions/*.json) into Sirah Digital as DRAFTS.
 *
 *     node scripts/check-english-questions.mjs --text .english-text
 *     npx tsx --conditions=react-server scripts/import-english-questions.ts
 *     npx tsx --conditions=react-server scripts/import-english-questions.ts --commit
 *     npx tsx --conditions=react-server scripts/import-english-questions.ts --org <slug> --commit
 *
 * `--org` names the school by SLUG. Two organizations are called "Sirah
 * Digital" on this deployment, and a lookup by name cannot tell them apart: it
 * silently picks one, which is how a first run landed in the copy nobody signs
 * into. A slug is unique, and the run prints the one it chose.
 *
 * Run the checker first: it is the one that compares every extract with the
 * book, and this script refuses to run while it would fail.
 *
 * ---------------------------------------------------------------------------
 * What each kind becomes
 * ---------------------------------------------------------------------------
 *   competency → MCQ, 1 mark, marked automatically.
 *   extract    → CASE_STUDY, 5 marks: the extract and every part in one
 *                question, marked by a teacher against a rubric with one
 *                criterion per part — the board-paper form. AND each mcq part
 *                again as its own 1-mark MCQ carrying the extract, so the parts
 *                a machine can mark reach mastery without waiting for anyone.
 *   short      → SA, 3 marks, rubric Content 2 + Expression 1.
 *   long       → LA, 6 marks, rubric Content 3 + Organisation 1.5 + Accuracy 1.5.
 *
 * ---------------------------------------------------------------------------
 * Why DRAFT, and why no provenance
 * ---------------------------------------------------------------------------
 * Every question arrives as a DRAFT through `createQuestion` — the validator,
 * `validateRubric`, the curriculum-fit check and the duplicate hash all apply,
 * and the hash makes a second run a no-op. An English teacher approves them.
 *
 * `provenance` is deliberately left unstamped. The extracts quote NCERT's text,
 * and the question library copies only stamped questions to other schools, so
 * these stay in Sirah Digital until somebody decides — with the NCERT
 * permission question in mind — that they may travel.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createQuestion, type QuestionInput } from "../src/core/questions";
import { validateRubric, type Rubric } from "../src/core/questions/rubric";
import { validateQuestion } from "../src/core/questions/validate";

const QUESTIONS_DIR = "prisma/english-questions";
const TEXT_DIR = ".english-text";
const ORGANIZATION_NAME = "Sirah Digital";

function organizationArg(): string | undefined {
  const at = process.argv.indexOf("--org");
  return at !== -1 ? process.argv[at + 1] : undefined;
}

/** The app subject each NCERT book is filed under. */
const BOOK_SUBJECT: Record<string, { grade: number; code: string }> = {
  jeff1: { grade: 10, code: "ENG" },
  jefp1: { grade: 10, code: "ENGFP" },
  iebe1: { grade: 9, code: "ENG" },
  gw10: { grade: 10, code: "ENGGW" },
  gw9: { grade: 9, code: "ENGGW" },
};

const FORM_NAMES: Record<string, string> = {
  "formal-letter": "Formal letter",
  "analytical-paragraph": "Analytical paragraph",
  "descriptive-paragraph": "Descriptive paragraph",
  story: "Story",
  "diary-entry": "Diary entry",
};

/** Roughly how long each takes, for durations a remedial paper derives. */
const SECONDS = { mcq: 60, extract: 600, short: 240, long: 540 };

type Choice = { text: string; correct: boolean };
type Part = { type: "mcq" | "vsa" | "sa"; prompt: string; marks: number; options?: Choice[]; answer: string };
type Criterion = { label: string; marks: number; descriptor?: string };
type Difficulty = "EASY" | "MEDIUM" | "HARD";
type SourceQuestion =
  | { id: string; kind: "competency"; outcome: string; difficulty: Difficulty; marks: number; stem: string; options: Choice[]; explanation: string }
  | { id: string; kind: "extract"; source: string; outcome: string; difficulty: Difficulty; marks: number; extract: string; parts: Part[] }
  | { id: string; kind: "short" | "long"; lifeSkill?: string; outcome: string; difficulty: Difficulty; marks: number; stem: string; valuePoints: string[]; rubric: Criterion[] }
  | { id: string; kind: "grammar"; task: string; outcome: string; difficulty: Difficulty; marks: number; stem: string; options: Choice[]; explanation: string }
  | { id: string; kind: "writing"; form: string; outcome: string; difficulty: Difficulty; marks: number; stem: string; valuePoints: string[]; rubric: Criterion[] };
type BookFile = { book: string; chapters: { number: number; questions: SourceQuestion[] }[] };

const ROMAN = ["i", "ii", "iii", "iv", "v", "vi"];
const KEYS = ["A", "B", "C", "D"];

const toOptions = (choices: Choice[]) =>
  choices.map((choice, index) => ({ key: KEYS[index]!, text: choice.text.trim(), isCorrect: choice.correct }));

const introFor = (source: string) =>
  source === "poem"
    ? "Read the following lines and answer the questions that follow."
    : "Read the following extract and answer the questions that follow.";

/** What one source question becomes: its own row, and for an extract its MCQ parts too. */
function build(question: SourceQuestion, base: Pick<QuestionInput, "subjectId" | "chapterId" | "outcomeIds" | "source">): { label: string; input: QuestionInput }[] {
  const common = { ...base, difficulty: question.difficulty };

  if (question.kind === "competency" || question.kind === "grammar") {
    return [{
      label: question.id,
      input: { ...common, type: "MCQ", marks: 1, expectedTimeSeconds: SECONDS.mcq, stem: question.stem.trim(), options: toOptions(question.options), explanation: question.explanation.trim() },
    }];
  }

  if (question.kind === "extract") {
    const extract = question.extract.trim();
    const partText = question.parts.map((part, index) => {
      const lines = [`(${ROMAN[index]}) ${part.prompt.trim()} (${part.marks} ${part.marks === 1 ? "mark" : "marks"})`];
      if (part.type === "mcq" && part.options) {
        part.options.forEach((option, optionIndex) => lines.push(`    (${"abcd"[optionIndex]}) ${option.text.trim()}`));
      }
      return lines.join("\n");
    });
    const rubric: Rubric = {
      criteria: question.parts.map((part, index) => ({
        id: `p${index + 1}`,
        label: `Part (${ROMAN[index]})`,
        marks: part.marks,
        descriptor: `${part.prompt.trim()} — ${part.answer.trim()}`,
      })),
    };
    const caseStudy: QuestionInput = {
      ...common,
      type: "CASE_STUDY",
      marks: 5,
      expectedTimeSeconds: SECONDS.extract,
      stem: `${introFor(question.source)}\n\n${extract}\n\n${partText.join("\n\n")}`,
      rubric,
      explanation: `Expected answers:\n${question.parts.map((part, index) => `(${ROMAN[index]}) ${part.answer.trim()}`).join("\n")}`,
      answerKey: null,
    };
    const mcqs = question.parts.flatMap((part, index) =>
      part.type === "mcq" && part.options
        ? [{
            label: `${question.id}-mcq${index + 1}`,
            input: {
              ...common,
              type: "MCQ" as const,
              marks: 1,
              expectedTimeSeconds: SECONDS.mcq * 2,
              stem: `${introFor(question.source)}\n\n${extract}\n\n${part.prompt.trim()}`,
              options: toOptions(part.options),
              explanation: part.answer.trim(),
            },
          }]
        : [],
    );
    return [{ label: question.id, input: caseStudy }, ...mcqs];
  }

  const lead =
    question.kind === "long" && question.lifeSkill
      ? `Life skill: ${question.lifeSkill}.\n\n`
      : question.kind === "writing"
        ? `${FORM_NAMES[question.form] ?? question.form}, 100–120 words.\n\n`
        : "";
  return [{
    label: question.id,
    input: {
      ...common,
      type: question.kind === "short" ? "SA" : "LA",
      marks: question.marks,
      expectedTimeSeconds: question.kind === "short" ? SECONDS.short : SECONDS.long,
      stem: question.stem.trim(),
      rubric: {
        criteria: question.rubric.map((criterion, index) => ({
          id: `c${index + 1}`,
          label: criterion.label.trim(),
          marks: criterion.marks,
          descriptor: criterion.descriptor?.trim() || null,
        })),
      },
      explanation: `${lead}Value points:\n${question.valuePoints.map((point) => `• ${point.trim()}`).join("\n")}`,
      answerKey: null,
    },
  }];
}

async function main() {
  const commit = process.argv.includes("--commit");

  // The checker is the only thing that compares extracts with the book.
  try {
    execFileSync(process.execPath, ["scripts/check-english-questions.mjs", "--text", TEXT_DIR], { stdio: "pipe" });
  } catch (error) {
    const output = (error as { stdout?: Buffer }).stdout?.toString() ?? String(error);
    console.error(`The checker failed — fix these first:\n${output}`);
    process.exitCode = 1;
    return;
  }

  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  const slug = organizationArg();
  const organization = await db.organization.findFirstOrThrow({
    where: slug ? { slug } : { name: ORGANIZATION_NAME },
    select: { id: true, name: true, slug: true },
  });
  // The author the NCERT bank already lives under — live, imported rows only,
  // as every script touching that organization must filter. A school with no
  // imported question yet (the bank arriving somewhere new) is authored by its
  // owner, which is what the library copier does too.
  const anchor = await db.question.findFirst({
    where: { organizationId: organization.id, source: "IMPORTED", deletedAt: null },
    select: { createdById: true },
  });
  const membership = await db.membership.findFirstOrThrow({
    where: {
      organizationId: organization.id,
      status: "ACTIVE",
      ...(anchor ? { userId: anchor.createdById } : { role: "OWNER" }),
    },
    select: { userId: true, role: true },
  });
  const actor = { organizationId: organization.id, userId: membership.userId, role: membership.role };

  const counts = { planned: 0, created: 0, duplicate: 0, refused: 0 };
  const byType: Record<string, number> = {};
  const problems: string[] = [];

  for (const file of fs.readdirSync(QUESTIONS_DIR).filter((name) => name.endsWith(".json")).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, file), "utf8")) as BookFile;
    const book = BOOK_SUBJECT[data.book];
    if (!book) throw new Error(`${file}: unknown book ${data.book}`);

    for (const chapterSource of data.chapters) {
      const chapter = await db.chapter.findFirst({
        where: { number: chapterSource.number, subject: { code: book.code, grade: { number: book.grade, board: { code: "CBSE" } } } },
        select: { id: true, subjectId: true },
      });
      if (!chapter) {
        problems.push(`${data.book} ch${chapterSource.number}: chapter not found`);
        continue;
      }

      for (const question of chapterSource.questions) {
        const outcome = await db.learningOutcome.findFirst({
          where: { code: question.outcome, topic: { chapterId: chapter.id } },
          select: { id: true },
        });
        if (!outcome) {
          problems.push(`${question.id}: outcome ${question.outcome} not found in chapter`);
          counts.refused++;
          continue;
        }

        for (const { label, input } of build(question, {
          subjectId: chapter.subjectId,
          chapterId: chapter.id,
          outcomeIds: [outcome.id],
          source: "IMPORTED",
        })) {
          // The pure checks, so the dry run refuses exactly what the commit would.
          const rubricProblems = validateRubric(input.rubric ?? null, input.marks);
          const validation = validateQuestion({
            type: input.type,
            stem: input.stem,
            options: input.options,
            answerKey: input.answerKey,
            explanation: input.explanation,
            hint: input.hint,
            marks: input.marks,
            outcomeIds: input.outcomeIds,
          });
          if (rubricProblems.length || !validation.valid) {
            const first = rubricProblems[0]?.message ?? validation.problems.find((p) => p.severity === "error")?.message;
            problems.push(`${label}: ${first}`);
            counts.refused++;
            continue;
          }
          counts.planned++;
          byType[input.type] = (byType[input.type] ?? 0) + 1;

          if (commit) {
            const result = await createQuestion(actor, input);
            if (result.ok) counts.created++;
            else if (result.code === "DUPLICATE") counts.duplicate++;
            else {
              problems.push(`${label}: ${"message" in result ? result.message : result.code}`);
              counts.refused++;
            }
          }
        }
      }
    }
  }

  await db.$disconnect();
  console.log(
    `\nClass 9 and 10 English written questions — ${commit ? "COMMIT" : "dry run"} into ${organization.name} (${organization.slug})`,
  );
  for (const problem of problems) console.log(`  ERROR  ${problem}`);
  console.log("\n" + Object.entries(counts).map(([key, value]) => `  ${key.padEnd(10)} ${value}`).join("\n"));
  console.log("  by type    " + Object.entries(byType).map(([type, n]) => `${type} ${n}`).join(", "));
  console.log(commit ? "\nDone. Every question is a DRAFT." : "\nNothing written. Re-run with --commit to apply.");
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
