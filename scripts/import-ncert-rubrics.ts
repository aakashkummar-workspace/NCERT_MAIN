/**
 * Import the CBSE 2025-26 sample-paper marking schemes from the NCERT project
 * (data/rubrics.json) as DRAFT written questions carrying their mark schemes.
 *
 *     npx tsx --conditions=react-server scripts/import-ncert-rubrics.ts
 *     npx tsx --conditions=react-server scripts/import-ncert-rubrics.ts --commit
 *
 * `--conditions=react-server` is what lets a script import `core/`, which is
 * marked `server-only`; that package throws under any other condition.
 *
 * ---------------------------------------------------------------------------
 * Why DRAFT, and never approved
 * ---------------------------------------------------------------------------
 * The source's `prompt` is documented as "the stem, abbreviated; for the
 * reviewer, not the grader". A case study arrives as "Carpooling case study.
 * (i) Distance between B and C." with no data and no passage — a question no
 * student could answer. Twelve of the twenty-three also carry `needsReview`,
 * where turning the examiner's prose into steps took a judgement. So every one
 * lands as a DRAFT with the full scheme excerpt, its provenance and its review
 * notes in the explanation, and a teacher completes the wording from the
 * sample paper before approving it. A draft cannot be put in a paper.
 *
 * ---------------------------------------------------------------------------
 * Through `createQuestion`, not around it
 * ---------------------------------------------------------------------------
 * The question importer beside this file wrote rows over the superuser
 * connection and so met none of the app's rules. This one calls the same
 * function a teacher's save calls: the question validator, `validateRubric`
 * (criteria must sum to the marks, in halves, at most eight), the curriculum-
 * fit check on the outcome, and the per-tenant duplicate hash — which is also
 * what makes a second run a no-op.
 *
 * ---------------------------------------------------------------------------
 * How a step becomes a criterion
 * ---------------------------------------------------------------------------
 * The source marks by keyword against a photographed answer; the app marks by
 * a person against named criteria. Each step becomes one criterion labelled
 * with what it awards, worth its marks; a "choose any N" step is worth N times
 * its per-item marks, and its options become the descriptor, so the marker sees
 * every acceptable point. Keywords are not carried: they are machine-matching
 * hints, and a human marker reading them as a checklist would mark down correct
 * answers worded differently — which `acceptEquivalentWording` exists to allow.
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createQuestion, type QuestionInput } from "../src/core/questions";
import { validateRubric, type Rubric } from "../src/core/questions/rubric";
import { validateQuestion } from "../src/core/questions/validate";

const SOURCE = "C:\\dev\\sirah_project\\NCERT\\data\\rubrics.json";

/** Which app subject each NCERT book lives in. */
const BOOK_SUBJECT: Record<string, { grade: number; code: string }> = {
  jemh1: { grade: 10, code: "MATH" },
  jesc1: { grade: 10, code: "SCI" },
  jess1: { grade: 10, code: "SST" },
  jess2: { grade: 10, code: "SSTEC" },
  jess3: { grade: 10, code: "SSTHI" },
  jess4: { grade: 10, code: "SSTPS" },
};

/**
 * The learning outcome each question tests, chosen by reading its prompt
 * against the chapter's outcomes. Without one a draft can be saved but never
 * approved, and would never inform mastery once it was.
 */
const OUTCOME: Record<string, string> = {
  "class10-science-2025-26-q10": "S10-05-7",
  "class10-science-2025-26-q11-a": "S10-05-5",
  "class10-science-2025-26-q13": "S10-06-1",
  "class10-science-2025-26-q16-a": "S10-07-2",
  "class10-science-2025-26-q25": "S10-03-1",
  "class10-science-2025-26-q28": "S10-02-2",
  "class10-science-2025-26-q34-a": "S10-11-4",
  "class10-science-2025-26-q36": "S10-11-3",
  "class10-science-2025-26-q37": "S10-12-2",
  "class10-mathematics-basic-2025-26-q21-b": "M10-01-2",
  "class10-mathematics-basic-2025-26-q25-a": "M10-08-4",
  "class10-mathematics-basic-2025-26-q28": "M10-10-5",
  "class10-mathematics-basic-2025-26-q31": "M10-05-6",
  "class10-mathematics-basic-2025-26-q33-b": "M10-04-4",
  "class10-mathematics-basic-2025-26-q34-a": "M10-09-4",
  "class10-mathematics-basic-2025-26-q36-iii-a": "M10-07-1",
  "class10-social-science-2025-26-q5-a": "H10-03-1",
  "class10-social-science-2025-26-q16": "G10-04-1",
  "class10-social-science-2025-26-q24": "P10-02-1",
  "class10-social-science-2025-26-q28": "P10-01-1",
  "class10-social-science-2025-26-q35": "EC10-01-2",
  "class10-social-science-2025-26-q37": "EC10-04-3",
  "class10-social-science-2025-26-q38-b": "EC10-02-4",
};

const TYPE: Record<string, QuestionInput["type"]> = {
  vsa: "VSA",
  sa: "SA",
  la: "LA",
  "case-study": "CASE_STUDY",
};

type Step = {
  id: string;
  kind?: string;
  marks?: number;
  marksEach?: number;
  chooseAtLeast?: number;
  awardFor: string;
  options?: { id: string; awardFor: string }[];
};
type SourceRubric = {
  id: string;
  paper: string;
  session: string;
  questionNo: number;
  variant?: string;
  type: string;
  maxMarks: number;
  bookCode: string;
  chapter: number;
  prompt: string;
  scheme: { file: string; page: number; excerpt?: string };
  steps: Step[];
  needsReview?: boolean;
  reviewNotes?: string[];
};

function toRubric(source: SourceRubric): Rubric {
  return {
    criteria: source.steps.map((step, index) => {
      const marks = step.marks ?? (step.marksEach ?? 0) * (step.chooseAtLeast ?? 1);
      const descriptor =
        step.options && step.options.length > 0
          ? `Any ${step.chooseAtLeast ?? 1} of: ${step.options.map((o) => o.awardFor).join("; ")}`
          : null;
      // Labels must be unique within a scheme; two steps awarding the same
      // wording are told apart by their position.
      const label = step.awardFor.trim().replace(/^./, (c) => c.toUpperCase());
      return { id: step.id || `s${index + 1}`, label, marks, descriptor };
    }),
  };
}

function explanation(source: SourceRubric): string {
  const parts = [
    `Draft from the CBSE ${source.session} sample question paper (${source.paper}), question ${source.questionNo}${source.variant ? `, option ${source.variant}` : ""}. The wording above is abbreviated — complete it from the paper before approving.`,
    source.scheme.excerpt ? `Marking scheme (verbatim, ${source.scheme.file} p.${source.scheme.page}): ${source.scheme.excerpt}` : null,
    source.needsReview && source.reviewNotes?.length ? `Needs review: ${source.reviewNotes.join("; ")}` : null,
  ];
  return parts.filter(Boolean).join("\n\n");
}

async function main() {
  const commit = process.argv.includes("--commit");
  const sources = (JSON.parse(fs.readFileSync(SOURCE, "utf8")) as { rubrics: SourceRubric[] }).rubrics;

  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  // The organization and author the NCERT bank already lives under.
  const anchor = await db.question.findFirstOrThrow({
    where: { source: "IMPORTED", deletedAt: null },
    select: { organizationId: true, createdById: true },
  });
  if (!anchor.organizationId) throw new Error("Imported questions have no organization.");
  const organizationId = anchor.organizationId;
  const membership = await db.membership.findFirstOrThrow({
    where: { organizationId, userId: anchor.createdById },
    select: { role: true },
  });
  const actor = { organizationId, userId: anchor.createdById, role: membership.role };

  const counts = { planned: 0, created: 0, duplicate: 0, needsReview: 0, refused: 0 };
  const problems: string[] = [];

  for (const source of sources) {
    const book = BOOK_SUBJECT[source.bookCode];
    const outcomeCode = OUTCOME[source.id];
    const type = TYPE[source.type];
    if (!book || !outcomeCode || !type) {
      problems.push(`${source.id}: no subject, outcome or type mapping`);
      counts.refused++;
      continue;
    }
    const chapter = await db.chapter.findFirst({
      where: { number: source.chapter, subject: { code: book.code, grade: { number: book.grade, board: { code: "CBSE" } } } },
      select: { id: true, subjectId: true },
    });
    const outcome = chapter
      ? await db.learningOutcome.findFirst({ where: { code: outcomeCode, topic: { chapterId: chapter.id } }, select: { id: true } })
      : null;
    if (!chapter || !outcome) {
      problems.push(`${source.id}: chapter ${source.chapter} or outcome ${outcomeCode} not found`);
      counts.refused++;
      continue;
    }

    const input: QuestionInput = {
      type,
      subjectId: chapter.subjectId,
      chapterId: chapter.id,
      difficulty: type === "LA" ? "HARD" : "MEDIUM",
      marks: source.maxMarks,
      stem: source.prompt.trim(),
      answerKey: null,
      rubric: toRubric(source),
      explanation: explanation(source),
      outcomeIds: [outcome.id],
      source: "IMPORTED",
    };

    // The pure checks, so the dry run refuses exactly what the commit would.
    const rubricProblems = validateRubric(input.rubric ?? null, input.marks);
    // The same fields `toDraft` in core/questions hands the validator on save.
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
      problems.push(`${source.id}: ${rubricProblems[0]?.message ?? JSON.stringify(validation)}`);
      counts.refused++;
      continue;
    }
    if (source.needsReview) counts.needsReview++;
    counts.planned++;

    if (commit) {
      const result = await createQuestion(actor, input);
      if (result.ok) counts.created++;
      else if (result.code === "DUPLICATE") counts.duplicate++;
      else {
        problems.push(`${source.id}: ${"message" in result ? result.message : result.code}`);
        counts.refused++;
      }
    }
  }

  await db.$disconnect();
  console.log(`\nCBSE sample-paper marking schemes — ${commit ? "COMMIT" : "dry run"}`);
  for (const p of problems) console.log(`  ERROR  ${p}`);
  console.log("\n" + Object.entries(counts).map(([k, v]) => `  ${k.padEnd(14)} ${v}`).join("\n"));
  console.log(commit ? "\nDone. Every question is a DRAFT." : "\nNothing written. Re-run with --commit to apply.");
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
