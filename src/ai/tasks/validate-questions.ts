import "server-only";
import { z } from "zod";
import { runTask, type TaskOutcome } from "../gateway";

/**
 * The second gate on a generated question.
 *
 * ---------------------------------------------------------------------------
 * What this adds that the deterministic validator cannot
 * ---------------------------------------------------------------------------
 * `core/questions/validate.ts` catches everything a rule can catch: two correct
 * options, a missing key, a stem too short to be a question. It cannot catch
 * the failures that actually make a generated question unusable —
 *
 *   - the answer is sitting in the stem
 *   - the question needs a chapter the class has not reached
 *   - three of the four options are obviously silly, so it measures nothing
 *   - it reads like a university paper, not a Class 10 one
 *
 * — because each needs the meaning of the sentence, not its shape.
 *
 * ---------------------------------------------------------------------------
 * Reject and flag are different, and the difference is the whole design
 * ---------------------------------------------------------------------------
 * **Reject never reaches a teacher.** Answer leakage and out-of-scope content
 * are wrong in ways a teacher should not have to spend attention on.
 *
 * **Flag reaches the teacher, with the reason on the card.** Implausible
 * distractors and reading level are judgements, and a machine overruling a
 * teacher on a judgement is how a product gets turned off. The teacher is the
 * last gate; this exists to make that gate cheap to operate, not to remove it.
 *
 * Runs on FAST. It is a reading task with a fixed rubric, not a writing task,
 * and at roughly a thousandth of a dollar a question it can run on every draft
 * without anybody thinking about the bill.
 */

export const Verdict = z.object({
  index: z.number().int().min(0),
  /**
   * `reject` is reserved for the two objective failures. Everything else is a
   * flag, because everything else is an opinion.
   */
  reject: z.boolean(),
  reasons: z
    .array(
      z.object({
        code: z.enum([
          "answer-in-stem",
          "out-of-scope",
          "implausible-distractors",
          "options-overlap",
          "reading-level",
          "ambiguous",
        ]),
        /** One sentence, shown to the teacher verbatim. */
        note: z.string().min(5).max(240),
      }),
    )
    .max(4),
});

export const ValidationBatch = z.object({ verdicts: z.array(Verdict).max(12) });

export type Verdict = z.infer<typeof Verdict>;
export type ValidationBatch = z.infer<typeof ValidationBatch>;

/** Reasons that stop a question reaching a person at all. */
export const REJECTING: ReadonlySet<string> = new Set([
  "answer-in-stem",
  "out-of-scope",
]);

export type Reviewable = {
  stem: string;
  type: string;
  options: { key: string; text: string; isCorrect: boolean }[] | null;
  explanation: string | null;
};

export type ValidationContext = {
  organizationId: string;
  userId: string;
  /** The board, above the breakpoint — see the note in generate-questions. */
  boardName: string;
  gradeLabel: string;
  subjectName: string;
  chapterTitle: string;
  outcomes: { code: string; statement: string }[];
  questions: Reviewable[];
};

/**
 * The cacheable prefix.
 *
 * The rubric and the chapter, both stable. Validating a second batch on the
 * same chapter reads the same prefix — which is the difference between this
 * costing a thousandth of a dollar a question and costing ten times that.
 */
export function buildSystem(context: ValidationContext): string {
  const outcomes = [...context.outcomes]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((outcome) => `- ${outcome.code}: ${outcome.statement}`)
    .join("\n");

  return `You are reviewing draft examination questions for ${context.gradeLabel} ${context.subjectName}, chapter "${context.chapterTitle}", in the ${context.boardName} curriculum.

You are not writing questions and not improving them. You are deciding, for each one, whether a teacher should see it — and if so, what to warn them about.

REJECT a question only for these two, and be strict about both:
- answer-in-stem: the stem gives the answer away, so the question measures reading rather than knowing.
- out-of-scope: answering it needs material outside the learning outcomes below. A question that is merely hard is IN scope.

FLAG a question, without rejecting it, for any of these:
- implausible-distractors: the wrong options are obviously wrong, so the question separates nobody.
- options-overlap: two options mean the same thing, or one contains another.
- reading-level: the language is beyond a Class 9 or 10 student reading in English as a second or third language. Difficulty of the MATHEMATICS is not a reading-level problem.
- ambiguous: the question has more than one defensible answer.

Say nothing about a question that is fine. An empty reasons list is the expected outcome for most of them, and inventing a criticism to look useful is worse than silence — a teacher who learns the warnings are noise stops reading them.

Each note is one sentence, addressed to the teacher, naming the specific problem in this specific question. Never "consider revising".

LEARNING OUTCOMES FOR THIS CHAPTER
${outcomes || "(none authored yet)"}`;
}

/** The fresh part: the drafts themselves. */
export function buildRequest(context: ValidationContext): string {
  const questions = context.questions
    .map((question, index) => {
      const options = question.options
        ? question.options
            .map((option) => `    ${option.key}. ${option.text}${option.isCorrect ? "  [correct]" : ""}`)
            .join("\n")
        : null;
      return [
        `[${index}] (${question.type})`,
        `  ${question.stem}`,
        options,
        question.explanation ? `  Explanation: ${question.explanation}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return `Review these ${context.questions.length} drafts. Return one verdict per draft, using the index shown.\n\n${questions}`;
}

export async function validateQuestions(
  context: ValidationContext,
): Promise<TaskOutcome<ValidationBatch>> {
  return runTask({
    organizationId: context.organizationId,
    userId: context.userId,
    feature: "QUESTION_VALIDATION",
    // Reading against a fixed rubric, not writing. Cheap enough to run on
    // every draft without anybody weighing it up.
    tier: "FAST",
    effort: "low",
    system: buildSystem(context),
    messages: [{ role: "user", content: buildRequest(context) }],
    schema: ValidationBatch,
    schemaName: "ValidationBatch",
    maxTokens: 200 * context.questions.length + 500,
    input: {
      boardName: context.boardName,
      chapterTitle: context.chapterTitle,
      count: context.questions.length,
      outcomeCodes: context.outcomes.map((outcome) => outcome.code),
    },
    safeFields: ["boardName", "chapterTitle", "count", "outcomeCodes"],
    requestedCount: context.questions.length,
    // Deliberately NOT metered against the teacher's generation allowance.
    // Validation is part of what generation promises, not a second thing they
    // spend — charging twice for one press would be a surprise on an invoice.
  });
}
