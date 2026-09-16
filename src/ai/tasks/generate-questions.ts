import "server-only";
import { z } from "zod";
import { runTask, type TaskOutcome } from "../gateway";

/**
 * The question generation task.
 *
 * ---------------------------------------------------------------------------
 * What this actually is
 * ---------------------------------------------------------------------------
 * A prompt with a schema, split at a cache breakpoint. Everything the model
 * needs to know about the subject goes above the line and is identical between
 * calls; the specific ask goes below it. That split is worth roughly a
 * threefold difference in the bill, and nothing else about this file matters as
 * much.
 *
 *     [ cached ]  role, rules, output contract
 *     [ cached ]  the chapter, its topics, its learning outcomes
 *     [ cached ]  up to three approved questions, as style exemplars
 *     ── breakpoint ────────────────────────────────────────────────
 *     [ fresh  ]  how many, of what type and difficulty, and what to avoid
 *
 * ---------------------------------------------------------------------------
 * Grounding, and why the exemplars matter more than the instructions
 * ---------------------------------------------------------------------------
 * A learning outcome statement is the only grounding a generator has for what
 * a chapter is *for* — which is why `checkOutcomeStatement` insists on a
 * performable verb, and why 50 chapters deliberately have none rather than 400
 * invented ones.
 *
 * The exemplars are the grounding for what a question should *look* like.
 * Without them the model writes plausible questions in the wrong register for
 * a Class 10 board paper, and a teacher rejects all eight without being able to
 * say why. With them the request is "more like these", which is a far easier
 * thing to get right.
 */

/**
 * The shape a draft comes back in.
 *
 * Deliberately the shape `core/questions/validate.ts` already understands, so
 * a generated draft goes through the same validator a teacher's typing does —
 * the third caller of the one validator, as ARCHITECTURE promised. A separate
 * "AI question" type would be a second definition of valid.
 */
export const GeneratedQuestion = z.object({
  type: z.enum(["MCQ", "TRUE_FALSE", "NUMERIC", "VSA", "SA"]),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
  marks: z.number().int().min(1).max(6),
  stem: z.string().min(10).max(1200),
  options: z
    .array(
      z.object({
        key: z.string().min(1).max(2),
        text: z.string().min(1).max(300),
        isCorrect: z.boolean(),
      }),
    )
    .max(5)
    .nullable(),
  answerValue: z.number().nullable(),
  answerBoolean: z.boolean().nullable(),
  acceptedAnswers: z.array(z.string().max(200)).max(4).nullable(),
  explanation: z.string().min(10).max(800),
});

export const GeneratedBatch = z.object({
  questions: z.array(GeneratedQuestion).min(1).max(12),
});

export type GeneratedQuestion = z.infer<typeof GeneratedQuestion>;
export type GeneratedBatch = z.infer<typeof GeneratedBatch>;

export type Exemplar = {
  stem: string;
  type: string;
  marks: number;
  options: { key: string; text: string; isCorrect: boolean }[] | null;
};

export type GenerationContext = {
  organizationId: string;
  userId: string;
  /** Everything above the cache breakpoint comes from here. */
  /**
   * The board whose syllabus this is.
   *
   * Above the cache breakpoint, and that has a cost consequence worth stating
   * plainly: the prefix is cached per byte, so a second board is a SECOND
   * cached prefix rather than a modification of the first. Each board pays its
   * own first-call price and caches from then on.
   *
   * It is included anyway, because the alternative is worse in both
   * directions. Hard-coded "CBSE" is a false statement to an ICSE school and
   * the model writes in the wrong register for the paper the student will
   * actually sit; putting the board below the breakpoint would leave a
   * contradiction — a system prompt naming one board and a request naming
   * another — which is the one thing a model handles unpredictably.
   *
   * It is stable per organization, so nothing here is volatile: the same
   * school produces a byte-identical prefix on every call.
   */
  boardName: string;
  subjectName: string;
  gradeLabel: string;
  chapterTitle: string;
  outcomes: { code: string; statement: string }[];
  exemplars: Exemplar[];
  /** And everything below it, from here. */
  count: number;
  types: string[];
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
  /** Stems already in the bank, so the model does not rewrite what exists. */
  avoid: string[];
};

/**
 * The cacheable prefix.
 *
 * Assembled from sorted, stable inputs only. A timestamp, a request id or an
 * unsorted list up here changes a byte, invalidates the whole prefix and
 * roughly triples the cost — with no visible symptom at all beyond the bill.
 */
export function buildSystem(context: GenerationContext): string {
  const outcomes = [...context.outcomes]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((outcome) => `- ${outcome.code}: ${outcome.statement}`)
    .join("\n");

  const exemplars = context.exemplars
    .map((exemplar, index) => {
      const options = exemplar.options
        ? exemplar.options.map((o) => `    ${o.key}. ${o.text}`).join("\n")
        : null;
      return [
        `Example ${index + 1} (${exemplar.type}, ${exemplar.marks} marks):`,
        `  ${exemplar.stem}`,
        options,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return `You write examination questions for the ${context.boardName} curriculum in India.

You are writing for ${context.gradeLabel} ${context.subjectName}, chapter "${context.chapterTitle}".

RULES
- Every question must be answerable from this chapter alone. A question that needs material from another chapter is wrong, however good it is.
- Write in the register of an Indian school examination paper: plain, direct, no preamble, no "let us consider".
- Use Indian names, places, currency and units where a context is needed.
- A multiple-choice question has exactly one correct option unless it is explicitly a multi-select. Distractors must be wrong for a REASON a student would plausibly hold — a distractor nobody would pick teaches nothing and measures nothing.
- Never write "all of the above", "none of the above", or an option that is twice the length of its siblings.
- The explanation states why the answer is right, in one or two sentences, as a teacher would say it to the class.
- Marks match the work: 1 for recall, 2-3 for a step of reasoning, 4+ for a multi-step derivation.

LEARNING OUTCOMES FOR THIS CHAPTER
${outcomes || "(none authored yet)"}

${exemplars ? `QUESTIONS ALREADY APPROVED FOR THIS CHAPTER, AS A GUIDE TO STYLE AND DIFFICULTY\n\n${exemplars}` : ""}`.trim();
}

/** The fresh part. Everything volatile lives here, below the breakpoint. */
export function buildRequest(context: GenerationContext): string {
  const avoid =
    context.avoid.length > 0
      ? `\n\nDo not write anything close to these, which are already in the bank:\n${context.avoid
          .map((stem) => `- ${stem.slice(0, 160)}`)
          .join("\n")}`
      : "";

  return `Write ${context.count} question${context.count === 1 ? "" : "s"}.

Type: ${context.types.join(" or ")}
Difficulty: ${context.difficulty}
Marks each: ${context.marks}${avoid}`;
}

/**
 * Ask for a batch.
 *
 * Returns whatever the gateway returns — including its refusals. Nothing here
 * throws, because a teacher pressing "generate" must never meet a stack trace,
 * and because AI is never on a blocking path.
 */
export async function generateQuestions(
  context: GenerationContext,
): Promise<TaskOutcome<GeneratedBatch>> {
  return runTask({
    organizationId: context.organizationId,
    userId: context.userId,
    feature: "QUESTION_GENERATION",
    // Generation is judgement work, and the tier where quality is worth its
    // price. Classification runs on FAST; this does not.
    tier: "BALANCED",
    effort: "high",
    system: buildSystem(context),
    messages: [{ role: "user", content: buildRequest(context) }],
    schema: GeneratedBatch,
    schemaName: "GeneratedBatch",
    // Roughly 400 tokens a question with reasoning, plus headroom.
    maxTokens: Math.min(8000, 600 * context.count + 1000),
    // Curriculum ids and counts. No student, no teacher, no organization name.
    input: {
      boardName: context.boardName,
      chapterTitle: context.chapterTitle,
      count: context.count,
      difficulty: context.difficulty,
      marks: context.marks,
      types: context.types,
      outcomeCodes: context.outcomes.map((outcome) => outcome.code),
    },
    safeFields: [
      "boardName",
      "chapterTitle",
      "count",
      "difficulty",
      "marks",
      "types",
      "outcomeCodes",
    ],
    requestedCount: context.count,
    // The promise on the plan, checked before the money. "5 AI generations a
    // month" is what a teacher bought; the dollar budget is our own guard.
    entitlementKey: "ai_generations_per_month",
  });
}
