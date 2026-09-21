/**
 * Map questions for CBSE Class 10 Social Science — the board paper's 5-mark
 * "Map skill" question (Section F).
 *
 *     npx tsx --conditions=react-server scripts/import-map-questions.ts --org <slug>            # dry run
 *     npx tsx --conditions=react-server scripts/import-map-questions.ts --org <slug> --commit
 *
 * Source: prisma/map-questions/cbse-10.json. Every place must be on CBSE's own
 * map list (.ncert-text/Social_Science_Sec_2025-26.txt, "Map work"): its `list`
 * field is the spelling printed there, and the run refuses to write anything if
 * one is missing. A map question about a place the board never asks for is a
 * question a student revises for nothing.
 *
 * Each question is an LA worth 5 marks, one rubric mark per place, filed as a
 * DRAFT through createQuestion — the same validator, rubric check and duplicate
 * hash as everything else. The bank has no map type, so:
 *  - the stem asks for the places to be located and labelled on a printed
 *    outline map, which is how the board sets it and what a paper sitting uses;
 *  - the explanation tells the marker where each place is, and that in an
 *    online sitting the student can only NAME the state, so marks there are a
 *    judgement for the teacher, not a promise of the paper.
 *
 * Class 9 has none, deliberately: the CBSE Class 9 map list follows the old
 * books (the French Revolution, India's relief and drainage), and the new
 * Class 9 book teaches almost none of it. See CLAUDE.md, "Sample papers".
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createQuestion, type QuestionInput } from "../src/core/questions";
import { validateRubric } from "../src/core/questions/rubric";
import { validateQuestion } from "../src/core/questions/validate";

const SOURCE = "prisma/map-questions/cbse-10.json";
const MAP_LIST = ".ncert-text/Social_Science_Sec_2025-26.txt";
const LETTERS = ["a", "b", "c", "d", "e"];

type Place = { label: string; list: string; where: string };
type MapQuestion = {
  id: string;
  subject: string;
  chapter: number;
  outcomes: string[];
  difficulty: "EASY" | "MEDIUM" | "HARD";
  places: Place[];
};

/** The syllabus text with words broken across lines rejoined ("Gandhi-\n nagar"). */
function normalise(text: string): string {
  return text.replace(/-\s*\r?\n\s*/g, "").replace(/\s+/g, " ").toLowerCase();
}

function build(question: MapQuestion): Omit<QuestionInput, "subjectId" | "chapterId" | "outcomeIds"> {
  const lines = question.places.map((place, index) => `(${LETTERS[index]}) ${place.label}`);
  return {
    type: "LA",
    marks: question.places.length,
    difficulty: question.difficulty,
    expectedTimeSeconds: 300,
    stem:
      "On the outline political map of India provided, locate and label the following with suitable symbols:\n" +
      lines.join("\n"),
    rubric: {
      criteria: question.places.map((place, index) => ({
        id: `c${index + 1}`,
        label: `(${LETTERS[index]}) ${place.label}`,
        marks: 1,
        descriptor: `Placed correctly — ${place.where} — and labelled.`,
      })),
    },
    explanation:
      "Where each is:\n" +
      question.places.map((place, index) => `(${LETTERS[index]}) ${place.label} — ${place.where}`).join("\n") +
      "\n\nMarked on a printed outline map. In an online sitting a student can only name the state, so award those marks as you judge fair.",
    answerKey: null,
    source: "IMPORTED",
  };
}

async function main() {
  const commit = process.argv.includes("--commit");
  const at = process.argv.indexOf("--org");
  const slug = at !== -1 ? process.argv[at + 1] : undefined;
  if (!slug) throw new Error("Pass --org <slug>. A name is not enough: two schools here share one.");

  const data = JSON.parse(fs.readFileSync(SOURCE, "utf8")) as { questions: MapQuestion[] };
  const mapList = normalise(fs.readFileSync(MAP_LIST, "latin1"));

  // The gate: nothing is written while any place is off the board's list.
  const offList: string[] = [];
  for (const question of data.questions) {
    if (question.places.length !== 5) offList.push(`${question.id}: has ${question.places.length} places, the board asks for 5`);
    for (const place of question.places) {
      if (!mapList.includes(normalise(place.list))) offList.push(`${question.id}: "${place.list}" is not on the CBSE map list`);
    }
  }
  if (offList.length > 0) {
    console.error(`Refused — fix these first:\n  ${offList.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }

  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  const organization = await db.organization.findUniqueOrThrow({ where: { slug }, select: { id: true, name: true } });
  const membership = await db.membership.findFirstOrThrow({
    where: { organizationId: organization.id, status: "ACTIVE", role: "OWNER" },
    select: { userId: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  const actor = { organizationId: organization.id, userId: membership.userId, role: membership.role };
  console.log(`Map questions — ${commit ? "COMMIT" : "dry run"} into ${organization.name} (${slug})`);

  const counts = { planned: 0, created: 0, duplicate: 0, refused: 0 };
  for (const question of data.questions) {
    const chapter = await db.chapter.findFirst({
      where: { number: question.chapter, subject: { code: question.subject, grade: { number: 10, board: { code: "CBSE" } } } },
      select: { id: true, subjectId: true },
    });
    if (!chapter) {
      console.log(`  ! ${question.id}: chapter not found`);
      counts.refused++;
      continue;
    }
    const outcomes = await db.learningOutcome.findMany({
      where: { code: { in: question.outcomes }, topic: { chapterId: chapter.id } },
      select: { id: true },
    });
    if (outcomes.length !== question.outcomes.length) {
      console.log(`  ! ${question.id}: an outcome is not in this chapter — import the curriculum draft first`);
      counts.refused++;
      continue;
    }

    const input: QuestionInput = {
      ...build(question),
      subjectId: chapter.subjectId,
      chapterId: chapter.id,
      outcomeIds: outcomes.map((outcome) => outcome.id),
    };
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
      console.log(`  ! ${question.id}: ${first}`);
      counts.refused++;
      continue;
    }
    counts.planned++;
    if (!commit) continue;
    const result = await createQuestion(actor, input);
    if (result.ok) counts.created++;
    else if (result.code === "DUPLICATE") counts.duplicate++;
    else {
      console.log(`  ! ${question.id}: ${"message" in result ? result.message : result.code}`);
      counts.refused++;
    }
  }

  console.log(`  planned    ${counts.planned}\n  created    ${counts.created}\n  duplicate  ${counts.duplicate}\n  refused    ${counts.refused}`);
  console.log(commit ? "Done. Every question is a DRAFT." : "Nothing written. Re-run with --commit to apply.");
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
