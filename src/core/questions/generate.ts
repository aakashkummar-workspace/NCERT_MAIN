import "server-only";
import { withTenant } from "@/db/tenant";
import { chapterGrounding } from "@/core/curriculum";
import { organizationBoard } from "@/core/organizations";
import { generateQuestions, type GeneratedQuestion } from "@/ai/tasks/generate-questions";
import {
  validateQuestions,
  REJECTING,
  type Verdict,
} from "@/ai/tasks/validate-questions";
import { validateQuestion, type AnswerKey, type Option } from "./validate";
import { createQuestion, type Actor, type QuestionInput } from "./index";

/**
 * Generation, from a teacher's press of a button to rows in the bank.
 *
 * ---------------------------------------------------------------------------
 * The gate is unchanged
 * ---------------------------------------------------------------------------
 * A generated question passes exactly what a typed one passes: the same
 * `validateQuestion`, the same curriculum-fit check, the same duplicate hash,
 * and the same DRAFT status waiting for a person to approve it. Nothing here
 * has a shortcut, and that is the point — **AI proposes, the database decides,
 * a human approves anything a student will see.**
 *
 * What generation adds is a filter *before* the human: a draft that fails the
 * validator is dropped here and never reaches the review queue. A teacher
 * reading eight questions of which three are malformed learns to skim, and
 * skimming is how a bad question reaches a class.
 */

export type GenerateInput = {
  chapterId: string;
  count: number;
  types: ("MCQ" | "TRUE_FALSE" | "NUMERIC" | "VSA" | "SA")[];
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
};

export type GenerateResult =
  | {
      ok: true;
      generationId: string;
      /** Saved as DRAFT, waiting for a person. */
      created: string[];
      /** Produced by the model but dropped before anyone saw them. */
      rejected: { stem: string; reason: string }[];
      costMicros: number;
    }
  | { ok: false; code: string; message: string };

export async function generateIntoBank(
  actor: Actor,
  input: GenerateInput,
): Promise<GenerateResult> {
  if (input.count < 1 || input.count > 10) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Ask for between 1 and 10 questions at a time.",
    };
  }

  // --- The grounding -------------------------------------------------------

  const chapter = await chapterGrounding(input.chapterId);
  if (!chapter) {
    return { ok: false, code: "NOT_FOUND", message: "We could not find that chapter." };
  }

  // A chapter id is a global id, so a hand-made request could name one from
  // another board's tree. The same answer as a chapter that does not exist:
  // for this organization, it does not.
  const board = await organizationBoard(actor.organizationId);
  if (chapter.boardCode !== board.code) {
    return { ok: false, code: "NOT_FOUND", message: "We could not find that chapter." };
  }

  if (chapter.outcomes.length === 0) {
    // Refused rather than attempted. An outcome statement is the only grounding
    // a generator has for what a chapter is for, and without one the model
    // writes plausible questions about the title — which is exactly the output
    // that wastes a teacher's evening.
    return {
      ok: false,
      code: "NO_OUTCOMES",
      message:
        "This chapter has no learning outcomes yet, so there is nothing to ground a question in. Ask your platform administrator to author them first.",
    };
  }

  const bank = await withTenant(actor.organizationId, (tx) =>
    tx.question.findMany({
      where: { chapterId: input.chapterId, deletedAt: null },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
  );

  const approved = bank.filter((question) => question.status === "APPROVED");

  return runGeneration(actor, input, {
    // From the chapter's own tree, so the prompt names the board the paper
    // will actually be sat under — not a default.
    boardName: chapter.boardName,
    subjectName: chapter.subjectName,
    gradeLabel: chapter.gradeLabel,
    chapterTitle: chapter.chapterTitle,
    outcomes: chapter.outcomes,
    // Three, and only approved ones. An exemplar list drawn from drafts would
    // teach the model to write what nobody has agreed is good yet.
    exemplars: approved.slice(0, 3).map((question) => ({
      stem: question.versions[0]?.stem ?? "",
      type: question.type,
      marks: question.marks,
      options: (question.versions[0]?.options as Option[] | null) ?? null,
    })),
    avoid: bank.flatMap((question) =>
      question.versions[0]?.stem ? [question.versions[0].stem] : [],
    ),
    primaryOutcomeId: chapter.outcomes[0]?.id,
    subjectId: chapter.subjectId,
  });
}

type Grounding = {
  boardName: string;
  subjectName: string;
  gradeLabel: string;
  chapterTitle: string;
  outcomes: { code: string; statement: string }[];
  exemplars: { stem: string; type: string; marks: number; options: Option[] | null }[];
  avoid: string[];
  primaryOutcomeId?: string;
  subjectId: string;
};

async function runGeneration(
  actor: Actor,
  input: GenerateInput,
  grounding: Grounding,
): Promise<GenerateResult> {
  const outcome = await generateQuestions({
    organizationId: actor.organizationId,
    userId: actor.userId,
    boardName: grounding.boardName,
    subjectName: grounding.subjectName,
    gradeLabel: grounding.gradeLabel,
    chapterTitle: grounding.chapterTitle,
    outcomes: grounding.outcomes,
    exemplars: grounding.exemplars,
    count: input.count,
    types: input.types,
    difficulty: input.difficulty,
    marks: input.marks,
    avoid: grounding.avoid,
  });

  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }

  const created: string[] = [];
  const rejected: { stem: string; reason: string }[] = [];

  // --- The deterministic gate first -----------------------------------------
  //
  // Cheap, certain, and it removes the drafts not worth paying a model to read.

  const survivors: { draft: GeneratedQuestion; candidate: QuestionInput }[] = [];

  for (const draft of outcome.value.questions) {
    const candidate = toInput(draft, input, grounding);
    const verdict = validateQuestion({
      type: candidate.type,
      marks: candidate.marks,
      stem: candidate.stem,
      options: candidate.options ?? null,
      answerKey: candidate.answerKey ?? null,
      explanation: candidate.explanation ?? null,
      outcomeIds: candidate.outcomeIds ?? [],
    });

    if (!verdict.valid) {
      rejected.push({
        stem: draft.stem.slice(0, 120),
        reason: verdict.problems
          .filter((problem) => problem.severity === "error")
          .map((problem) => problem.message)
          .join(" "),
      });
      continue;
    }
    survivors.push({ draft, candidate });
  }

  // --- Then the reading gate ------------------------------------------------
  //
  // The failures a rule cannot see: the answer sitting in the stem, a question
  // that needs a chapter they have not reached, four options of which three are
  // obviously silly.
  //
  // If this cannot run, the drafts still reach the teacher unflagged. AI is
  // never on a blocking path, and a validator that is down must not mean a
  // teacher gets nothing — they are the last gate either way.
  const verdicts = await reviewDrafts(actor, grounding, survivors.map((s) => s.candidate));

  for (const [index, { draft, candidate }] of survivors.entries()) {
    const verdict = verdicts.get(index);

    if (verdict?.reject) {
      // Never reaches a teacher. Answer leakage and out-of-scope content are
      // wrong in ways nobody should have to spend attention on.
      rejected.push({
        stem: draft.stem.slice(0, 120),
        reason:
          verdict.reasons.map((reason) => reason.note).join(" ") ||
          "The validator rejected it.",
      });
      continue;
    }

    const saved = await createQuestion(actor, {
      ...candidate,
      // Flags travel with the row, so the teacher reviewing it next week sees
      // what the validator saw.
      aiFlags: verdict?.reasons.map((reason) => ({
        code: reason.code,
        note: reason.note,
      })),
    });
    if (saved.ok) {
      created.push(saved.id);
    } else {
      rejected.push({
        stem: draft.stem.slice(0, 120),
        reason:
          saved.code === "DUPLICATE"
            ? "The bank already has this question."
            : saved.code === "MISFILED"
              ? saved.message
              : "It did not pass the validator.",
      });
    }
  }

  await withTenant(actor.organizationId, (tx) =>
    tx.aIGeneration.update({
      where: { id: outcome.generationId },
      data: {
        producedCount: outcome.value.questions.length,
        acceptedCount: created.length,
        // PARTIAL is honest when the model wrote eight and three were dropped.
        status: created.length === 0 ? "FAILED" : rejected.length > 0 ? "PARTIAL" : "SUCCEEDED",
      },
    }),
  );

  return {
    ok: true,
    generationId: outcome.generationId,
    created,
    rejected,
    costMicros: outcome.costMicros,
  };
}

/**
 * Ask the validator to read the survivors.
 *
 * Returns an empty map on any failure, which means every draft reaches the
 * teacher unflagged. That is the right default: a validator that is down must
 * not mean a teacher gets nothing, and they are the last gate either way.
 */
async function reviewDrafts(
  actor: Actor,
  grounding: Grounding,
  candidates: QuestionInput[],
): Promise<Map<number, Verdict>> {
  if (candidates.length === 0) return new Map();

  const outcome = await validateQuestions({
    organizationId: actor.organizationId,
    userId: actor.userId,
    boardName: grounding.boardName,
    gradeLabel: grounding.gradeLabel,
    subjectName: grounding.subjectName,
    chapterTitle: grounding.chapterTitle,
    outcomes: grounding.outcomes,
    questions: candidates.map((candidate) => ({
      stem: candidate.stem,
      type: candidate.type,
      options: candidate.options ?? null,
      explanation: candidate.explanation ?? null,
    })),
  });

  if (!outcome.ok) return new Map();

  return new Map(
    outcome.value.verdicts
      // A verdict is only usable if it names a draft that exists. A model that
      // renumbers is a model whose verdict lands on the wrong question, which
      // is worse than no verdict at all.
      .filter((verdict) => verdict.index >= 0 && verdict.index < candidates.length)
      .map((verdict) => [
        verdict.index,
        {
          ...verdict,
          // A "reject" carrying no rejecting reason is a contradiction, and the
          // conservative reading is that it is a flag.
          reject:
            verdict.reject &&
            verdict.reasons.some((reason) => REJECTING.has(reason.code)),
        },
      ]),
  );
}

/** The model's shape, mapped onto the one the bank already understands. */
function toInput(
  draft: GeneratedQuestion,
  input: GenerateInput,
  grounding: Grounding,
): QuestionInput {
  const options: Option[] | null =
    draft.options && draft.options.length > 0
      ? draft.options.map((option) => ({
          key: option.key,
          text: option.text,
          isCorrect: option.isCorrect,
        }))
      : null;

  let answerKey: AnswerKey = null;
  if (draft.type === "TRUE_FALSE" && draft.answerBoolean !== null) {
    answerKey = { kind: "boolean", correct: draft.answerBoolean };
  } else if (draft.type === "NUMERIC" && draft.answerValue !== null) {
    answerKey = { kind: "numeric", value: draft.answerValue, tolerance: 0 };
  } else if (
    (draft.type === "VSA" || draft.type === "SA") &&
    draft.acceptedAnswers &&
    draft.acceptedAnswers.length > 0
  ) {
    // Written types keep their accepted answers as a mark scheme for the
    // person who will read the real thing, not as an automatic marker.
    answerKey = {
      kind: "text",
      accepted: draft.acceptedAnswers,
      caseSensitive: false,
    };
  }

  return {
    type: draft.type,
    subjectId: grounding.subjectId,
    chapterId: input.chapterId,
    difficulty: draft.difficulty,
    marks: draft.marks,
    stem: draft.stem,
    options,
    answerKey,
    explanation: draft.explanation,
    outcomeIds: grounding.primaryOutcomeId ? [grounding.primaryOutcomeId] : [],
    source: "AI_GENERATED",
  };
}
