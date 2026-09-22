import "server-only";
import { z } from "zod";
import { runTask, type TaskOutcome } from "../gateway";

/**
 * Turning a teacher's sentence into the paper builder's own settings.
 *
 * "A 40-mark test on Triangles and Circles for 10-A, due Friday" becomes a
 * class, a scope, a shape and a window — and NOTHING else. The model never
 * chooses a question and never writes one: the builder fills the plan from
 * approved bank questions by rule (core/assessments/auto-fill.ts), so every
 * question on the resulting paper is one a teacher has already approved, and
 * the same plan always draws from the same pool.
 *
 * Classes and chapters are referred to by the index they were listed under,
 * never by id — the rule concept drafting and the validator follow, because a
 * mistyped uuid is a link to nothing that looks like a link to something.
 */

const TYPES = ["MCQ", "TRUE_FALSE", "NUMERIC", "ASSERTION_REASON", "VSA", "SA", "LA", "CASE_STUDY"] as const;

export const PaperPlan = z.object({
  /** False when the request is not for a paper at all; nothing is built. */
  understood: z.boolean(),
  /** One sentence to the teacher when `understood` is false, or an assumption worth stating. */
  note: z.string().max(300),
  classIndex: z.number().int().min(0).nullable(),
  title: z.string().min(3).max(120),
  chapterIndexes: z.array(z.number().int().min(0)).max(20),
  /** BOARD_PATTERN is the CBSE board paper's sections; CUSTOM is a mix. */
  shape: z.enum(["BOARD_PATTERN", "CUSTOM"]),
  /** CUSTOM only: how many questions. */
  questionCount: z.number().int().min(1).max(60),
  /** CUSTOM only: percentages by type. */
  typeMix: z.array(z.object({ type: z.enum(TYPES), percent: z.number().int().min(1).max(100) })).max(8),
  /** Percentages; the builder normalises them to 100. */
  difficulty: z.object({
    easy: z.number().int().min(0).max(100),
    medium: z.number().int().min(0).max(100),
    hard: z.number().int().min(0).max(100),
  }),
  durationMinutes: z.number().int().min(5).max(240),
  /** Calendar dates, YYYY-MM-DD, or null when the teacher named none. */
  opensOn: z.string().nullable(),
  closesOn: z.string().nullable(),
});

export type PaperPlan = z.infer<typeof PaperPlan>;

export type PlanContext = {
  organizationId: string;
  userId: string;
  boardName: string;
  /** In the order `classIndex` refers to. */
  classes: { name: string; subjectName: string; gradeLabel: string; boardPattern: boolean }[];
  /** In the order `chapterIndexes` refers to. */
  chapters: { number: number; title: string; subjectName: string; gradeLabel: string }[];
  request: string;
  /** Today in India, YYYY-MM-DD and the weekday — in the request, never the system prompt. */
  today: string;
};

export function buildSystem(boardName: string): string {
  return `You help a school teacher in India set a test. The teacher describes the paper in a sentence; you turn it into the settings of a paper builder. The builder then fills the paper with questions the teacher has already approved. You never choose or write questions yourself.

The board is ${boardName}.

WHAT YOU DECIDE

- classIndex: which of the teacher's classes the paper is for, by its number in the list. If the teacher names no class and has exactly one, use it. If they name none and have several, pick the one whose subject matches what they asked for; if that is still ambiguous, set understood to false and ask which class in note.
- chapterIndexes: the chapters the paper covers, by their numbers in the list, from the class's own subject only. "Triangles" means the chapter with that title. "The whole syllabus" or "everything so far" means every chapter listed for that subject. If they name a topic that is not a chapter title, pick the chapter it belongs to.
- shape: BOARD_PATTERN when they ask for a board-style, sample, pre-board or 80-mark board paper and the class is marked "board pattern available". Otherwise CUSTOM.
- questionCount and typeMix (CUSTOM only): a class test is usually 10 to 25 questions. If they give marks but not a count, remember most bank questions are 1 mark for objective types, 2 for very short, 3 for short and 5 for long answers, and choose a count and mix that adds up to about their marks. If they say "MCQ only" or "objective", use MCQ. With no preference, mostly MCQ with some short answers.
- difficulty: percentages for easy, medium and hard. Default 30, 50, 20. "Easy revision test" leans easy; "challenging" leans hard.
- durationMinutes: what they say; otherwise about 1.5 minutes a mark for objective papers and 2 minutes a mark with written answers, rounded to 5. A board pattern paper is 180.
- opensOn and closesOn: dates as YYYY-MM-DD, worked out from today's date given in the request. "Due Friday" is the coming Friday (closesOn) and opens today. "Next Monday" is a date, not a window: open that day and close it the same day. No date said: both null.
- title: short and plain, as a teacher would write it on the board, e.g. "Triangles and Circles — class test".

WHEN TO REFUSE

If the request is not about setting a paper, or names a subject none of the classes study, set understood to false, explain in one sentence in note, and fill the other fields with any valid values. Never invent a class or a chapter that is not listed.

note: when understood is true, one short sentence stating any assumption you made that the teacher should check (for example, which class you picked), or an empty string. Name classes and chapters by their names, never by their numbers in the lists — the teacher never sees the numbers.`;
}

export function buildRequest(context: PlanContext): string {
  const classes = context.classes
    .map(
      (klass, index) =>
        `[${index}] ${klass.name} — ${klass.subjectName}, ${klass.gradeLabel}${klass.boardPattern ? " (board pattern available)" : ""}`,
    )
    .join("\n");
  const chapters = context.chapters
    .map(
      (chapter, index) =>
        `[${index}] ${chapter.subjectName}, ${chapter.gradeLabel} — Chapter ${chapter.number}: ${chapter.title}`,
    )
    .join("\n");
  return `Today is ${context.today}.

THE TEACHER'S CLASSES
${classes}

CHAPTERS
${chapters}

THE REQUEST
${context.request}`;
}

export async function planPaper(context: PlanContext): Promise<TaskOutcome<PaperPlan>> {
  return runTask({
    organizationId: context.organizationId,
    userId: context.userId,
    feature: "PAPER_PLANNING",
    // Reading one sentence against two short lists. No marking and no
    // writing, so the cheapest tier that follows instructions carefully.
    tier: "FAST",
    effort: "low",
    system: buildSystem(context.boardName),
    messages: [{ role: "user", content: buildRequest(context) }],
    schema: PaperPlan,
    schemaName: "PaperPlan",
    maxTokens: 800,
    // The teacher's sentence goes to the provider — it is the request — but
    // never into the ledger, the Copilot's rule: only counts are recorded.
    input: {
      boardName: context.boardName,
      classCount: context.classes.length,
      chapterCount: context.chapters.length,
      requestLength: context.request.length,
    },
    safeFields: ["boardName", "classCount", "chapterCount", "requestLength"],
    // One use of the generation allowance: it is the same promise — "the AI
    // made me a paper" — and a free plan with no generations gets none.
    entitlementKey: "ai_generations_per_month",
  });
}
