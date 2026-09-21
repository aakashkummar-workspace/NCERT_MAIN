/**
 * Import the Class 9 and 10 Mathematics, Science and Social Science written
 * questions (prisma/written-questions/*.json) into one school, as DRAFTS.
 *
 *     node scripts/check-written-questions.mjs --text .ncert-text
 *     npx tsx --conditions=react-server scripts/import-written-questions.ts --org <slug>
 *     npx tsx --conditions=react-server scripts/import-written-questions.ts --org <slug> --commit
 *
 * `--org` is required and is a SLUG. Two organizations here share the name
 * "Sirah Digital", and the English importer's lookup by name once wrote 881
 * questions into the copy nobody signs into.
 *
 * ---------------------------------------------------------------------------
 * What each kind becomes
 * ---------------------------------------------------------------------------
 *   ar    → ASSERTION_REASON, 1 mark, in the shape the question editor writes
 *           and reads back ("Assertion (A): … / Reason (R): …" and the four
 *           standard options), so a teacher can open and edit one.
 *   vsa   → VSA, 2 marks · sa → SA, 3 marks · la → LA, 5 marks, each with its
 *           rubric and the model answer or worked solution in the explanation.
 *   case  → CASE_STUDY, 4 marks, a rubric criterion per part; and each mcq
 *           part again as its own 1-mark MCQ carrying the passage, so what a
 *           machine can mark reaches mastery without waiting for anyone.
 *
 * Everything goes through `createQuestion`: the validator, `validateRubric`,
 * the curriculum-fit check and the per-school duplicate hash, which makes a
 * second run a no-op. No provenance is stamped, so the question library does
 * not copy these on to other schools.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createQuestion, type QuestionInput } from "../src/core/questions";
import { validateRubric, type Rubric } from "../src/core/questions/rubric";
import { validateQuestion } from "../src/core/questions/validate";

const QUESTIONS_DIR = "prisma/written-questions";
const TEXT_DIR = ".ncert-text";

/** The app subject each NCERT book is filed under. Mirrors check-written-questions.mjs. */
const BOOK_SUBJECT: Record<string, { grade: number; code: string }> = {
  jemh1: { grade: 10, code: "MATH" },
  jesc1: { grade: 10, code: "SCI" },
  jess1: { grade: 10, code: "SST" },
  jess2: { grade: 10, code: "SSTEC" },
  jess3: { grade: 10, code: "SSTHI" },
  jess4: { grade: 10, code: "SSTPS" },
  iemh1: { grade: 9, code: "MATH" },
  iesc1: { grade: 9, code: "SCI" },
  iest1: { grade: 9, code: "SST" },
};

/** The question editor's own wording, so an imported item reads back as one. */
const AR_OPTIONS = [
  "Both A and R are true, and R is the correct explanation of A.",
  "Both A and R are true, but R is not the correct explanation of A.",
  "A is true, but R is false.",
  "A is false, but R is true.",
];

const SECONDS = { ar: 60, vsa: 180, sa: 300, la: 600, case: 600, mcq: 120 };
const KEYS = ["A", "B", "C", "D"];
const ROMAN = ["i", "ii", "iii", "iv", "v"];

type Difficulty = "EASY" | "MEDIUM" | "HARD";
type Choice = { text: string; correct: boolean };
type Criterion = { label: string; marks: number; descriptor?: string };
type Part = { type: "mcq" | "vsa" | "sa"; prompt: string; marks: number; options?: Choice[]; answer: string };
type Common = { id: string; outcome: string; difficulty: Difficulty; marks: number };
type SourceQuestion =
  | (Common & { kind: "ar"; assertion: string; reason: string; answer: "a" | "b" | "c" | "d"; explanation: string })
  | (Common & { kind: "vsa" | "sa" | "la"; stem: string; answer: string; valuePoints: string[]; rubric: Criterion[] })
  | (Common & { kind: "case"; passage: string; fromBook?: boolean; parts: Part[] });
type BookFile = { book: string; chapters: { number: number; questions: SourceQuestion[] }[] };

const TYPE = { vsa: "VSA", sa: "SA", la: "LA" } as const;

function build(
  question: SourceQuestion,
  base: Pick<QuestionInput, "subjectId" | "chapterId" | "outcomeIds" | "source">,
): { label: string; input: QuestionInput }[] {
  const common = { ...base, difficulty: question.difficulty };

  if (question.kind === "ar") {
    const correct = "abcd".indexOf(question.answer);
    return [{
      label: question.id,
      input: {
        ...common,
        type: "ASSERTION_REASON",
        marks: 1,
        expectedTimeSeconds: SECONDS.ar,
        stem: `Assertion (A): ${question.assertion.trim()}\nReason (R): ${question.reason.trim()}`,
        options: AR_OPTIONS.map((text, index) => ({ key: KEYS[index]!, text, isCorrect: index === correct })),
        explanation: question.explanation.trim(),
      },
    }];
  }

  if (question.kind === "case") {
    const passage = question.passage.trim();
    const partText = question.parts.map((part, index) => {
      const lines = [`(${ROMAN[index]}) ${part.prompt.trim()} (${part.marks} ${part.marks === 1 ? "mark" : "marks"})`];
      if (part.type === "mcq" && part.options) {
        part.options.forEach((option, optionIndex) => lines.push(`    (${"abcd"[optionIndex]}) ${option.text.trim()}`));
      }
      return lines.join("\n");
    });
    const intro = "Read the following and answer the questions that follow.";
    const rubric: Rubric = {
      criteria: question.parts.map((part, index) => ({
        id: `p${index + 1}`,
        label: `Part (${ROMAN[index]})`,
        marks: part.marks,
        descriptor: `${part.prompt.trim()} — ${part.answer.trim()}`,
      })),
    };
    const caseStudy = {
      label: question.id,
      input: {
        ...common,
        type: "CASE_STUDY" as const,
        marks: 4,
        expectedTimeSeconds: SECONDS.case,
        stem: `${intro}\n\n${passage}\n\n${partText.join("\n\n")}`,
        rubric,
        explanation: `Expected answers:\n${question.parts.map((part, index) => `(${ROMAN[index]}) ${part.answer.trim()}`).join("\n")}`,
        answerKey: null,
      },
    };
    const mcqs = question.parts.flatMap((part, index) =>
      part.type === "mcq" && part.options
        ? [{
            label: `${question.id}-mcq${index + 1}`,
            input: {
              ...common,
              type: "MCQ" as const,
              marks: 1,
              expectedTimeSeconds: SECONDS.mcq,
              stem: `${intro}\n\n${passage}\n\n${part.prompt.trim()}`,
              options: part.options.map((option, optionIndex) => ({
                key: KEYS[optionIndex]!,
                text: String(option.text).trim(),
                isCorrect: option.correct,
              })),
              explanation: part.answer.trim(),
            },
          }]
        : [],
    );
    return [caseStudy, ...mcqs];
  }

  return [{
    label: question.id,
    input: {
      ...common,
      type: TYPE[question.kind],
      marks: question.marks,
      expectedTimeSeconds: SECONDS[question.kind],
      stem: question.stem.trim(),
      rubric: {
        criteria: question.rubric.map((criterion, index) => ({
          id: `c${index + 1}`,
          label: criterion.label.trim(),
          marks: criterion.marks,
          descriptor: criterion.descriptor?.trim() || null,
        })),
      },
      explanation: `Model answer:\n${question.answer.trim()}\n\nValue points:\n${question.valuePoints.map((point) => `• ${point.trim()}`).join("\n")}`,
      answerKey: null,
    },
  }];
}

async function main() {
  const commit = process.argv.includes("--commit");
  const at = process.argv.indexOf("--org");
  const slug = at !== -1 ? process.argv[at + 1] : undefined;
  if (!slug) throw new Error("Pass --org <slug>. A name is not enough: two schools here share one.");

  try {
    execFileSync(process.execPath, ["scripts/check-written-questions.mjs", "--text", TEXT_DIR], { stdio: "pipe" });
  } catch (error) {
    const output = (error as { stdout?: Buffer }).stdout?.toString() ?? String(error);
    console.error(`The checker failed — fix these first:\n${output}`);
    process.exitCode = 1;
    return;
  }

  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  const organization = await db.organization.findUniqueOrThrow({ where: { slug }, select: { id: true, name: true, slug: true } });
  // The imported bank's author where there is one; otherwise the owner, as the
  // library copier does when the bank arrives somewhere new.
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
  console.log(`\nMaths, Science and SST written questions — ${commit ? "COMMIT" : "dry run"} into ${organization.name} (${organization.slug})`);
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
