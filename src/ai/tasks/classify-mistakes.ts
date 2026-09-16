import "server-only";
import { z } from "zod";
import { runTask, type TaskOutcome } from "../gateway";

/**
 * Typing the mistakes a rule could not.
 *
 * ---------------------------------------------------------------------------
 * Why this is the largest AI line in the product, and why it is not
 * ---------------------------------------------------------------------------
 * Classification runs once per wrong answer, which at 300 students and six
 * papers each is more calls than every other feature put together. Modelled
 * naively it is 27% of the bill — not because a call is dear but because volume
 * beats unit price every time.
 *
 * Two things bring it down to roughly a quarter of that, and both are structural
 * rather than a setting somebody has to remember:
 *
 *   1. **`core/mistakes/classify.ts` runs first.** A blank answer, a paper that
 *      timed out, a rushed answer on a concept the student can demonstrably do
 *      — all typed by rule, at zero cost and with no chance of being wrong.
 *      Only the genuinely ambiguous remainder arrives here.
 *   2. **This runs nightly, in batches, never on a submission.** Nothing in the
 *      product needs a mistake typed within the second: a student opening their
 *      bank an hour after a test sees the question, the marks and the
 *      explanation regardless — the type is the extra.
 *
 * ---------------------------------------------------------------------------
 * The one distinction worth paying for
 * ---------------------------------------------------------------------------
 * CONCEPTUAL versus PROCEDURAL versus MISREAD. "You do not understand this",
 * "you understood it and slipped", and "you answered a different question" lead
 * to three different evenings, and no rule can separate them because each needs
 * the meaning of what the student actually wrote.
 *
 * Getting it wrong in the confident direction is the worse failure. Telling a
 * student who understands the topic that they do not is how a revision tool
 * teaches somebody they are bad at Mathematics — so `unsure` is a first-class
 * answer here, and it is expected often.
 */

export const MistakeVerdict = z.object({
  index: z.number().int().min(0),
  type: z.enum(["CONCEPTUAL", "PROCEDURAL", "MISREAD", "CARELESS", "UNSURE"]),
  /**
   * Addressed to the student, in the second person, naming what actually went
   * wrong in this answer. Never "review the chapter".
   */
  note: z.string().min(10).max(240),
});

export const MistakeBatch = z.object({
  verdicts: z.array(MistakeVerdict).max(20),
});

export type MistakeVerdict = z.infer<typeof MistakeVerdict>;
export type MistakeBatch = z.infer<typeof MistakeBatch>;

export type Classifiable = {
  stem: string;
  type: string;
  options: { key: string; text: string; isCorrect: boolean }[] | null;
  /** What the student actually put, rendered for reading. */
  given: string | null;
  correct: string | null;
  /** The concept this sits under, when there is one. */
  conceptName: string | null;
};

export type ClassificationContext = {
  organizationId: string;
  /** Whoever triggered the run. A cron run passes the system account. */
  userId: string;
  /** The board, above the breakpoint — see the note in generate-questions. */
  boardName: string;
  gradeLabel: string;
  subjectName: string;
  mistakes: Classifiable[];
};

/**
 * The cacheable prefix: the rubric and the subject, both stable.
 *
 * Nothing volatile above the breakpoint — no timestamp, no run id, no count.
 * A nightly job that put the date in here would invalidate the prefix on every
 * single run, which is precisely the invisible way this bill triples.
 */
export function buildSystem(context: ClassificationContext): string {
  return `You are reading wrong answers from ${context.gradeLabel} ${context.subjectName} papers in the ${context.boardName} curriculum, and saying what KIND of mistake each one is.

You are not marking. The answer is already known to be wrong. You are deciding why, so the student is told something they can act on tonight.

CONCEPTUAL — they do not have the idea. The answer is not a slip from a correct method; it comes from a different and wrong understanding of what the question is about.
PROCEDURAL — the method was right and the execution was not. A sign dropped, a step skipped, an arithmetic slip, the right formula applied to the wrong quantity.
MISREAD — they answered a question that was not asked. The work is competent and addresses something else: the wrong variable, the wrong units, "how many" answered as "which".
CARELESS — they demonstrably know this and did not do what they know. Use this only when the answer contradicts itself or is a plain slip of the pen, never merely because the answer is short.
UNSURE — you cannot tell from what is here.

UNSURE is a real answer and you should use it often. A wrong option on a four-option multiple choice usually carries no information about WHY, and guessing between CONCEPTUAL and PROCEDURAL to look useful is worse than saying nothing: a student told they do not understand a topic they do understand learns to distrust the whole feature, and one told they were careless when they are actually stuck stops asking for help.

The note is one sentence, addressed to the student as "you", naming what went wrong in THIS answer. Never generic advice, never "revise the chapter", never encouragement without content.`;
}

export function buildRequest(context: ClassificationContext): string {
  const body = context.mistakes
    .map((mistake, index) => {
      const options = mistake.options
        ? mistake.options
            .map(
              (option) =>
                `    ${option.key}. ${option.text}${option.isCorrect ? "  [correct]" : ""}`,
            )
            .join("\n")
        : null;
      return [
        `[${index}] (${mistake.type})${mistake.conceptName ? ` — ${mistake.conceptName}` : ""}`,
        `  Question: ${mistake.stem}`,
        options,
        mistake.given ? `  They answered: ${mistake.given}` : `  They left it blank.`,
        mistake.correct ? `  Correct: ${mistake.correct}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return `Classify these ${context.mistakes.length} wrong answers. Return one verdict per item, using the index shown.\n\n${body}`;
}

export async function classifyMistakes(
  context: ClassificationContext,
): Promise<TaskOutcome<MistakeBatch>> {
  return runTask({
    organizationId: context.organizationId,
    userId: context.userId,
    feature: "CLASSIFICATION",
    // Reading against a fixed rubric. The cheapest tier is the right tier, and
    // at this volume it is the only one that would be affordable at all.
    tier: "FAST",
    effort: "low",
    system: buildSystem(context),
    messages: [{ role: "user", content: buildRequest(context) }],
    schema: MistakeBatch,
    schemaName: "MistakeBatch",
    maxTokens: 120 * context.mistakes.length + 400,
    input: {
      boardName: context.boardName,
      subjectName: context.subjectName,
      gradeLabel: context.gradeLabel,
      count: context.mistakes.length,
    },
    safeFields: ["boardName", "subjectName", "gradeLabel", "count"],
    requestedCount: context.mistakes.length,
    // Not metered against any teacher's allowance: nobody pressed a button for
    // this, and a student's revision aid is not something a teacher spends.
  });
}
