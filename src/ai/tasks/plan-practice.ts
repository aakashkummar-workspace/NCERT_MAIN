import "server-only";
import { z } from "zod";
import { runTask, type TaskOutcome } from "../gateway";

/**
 * Turning a teacher's sentence into practice sets to PROPOSE.
 *
 * "10-A needs practice on similar triangles, 8 questions, by Friday" becomes a
 * class, one or more ideas, a count and a day — and nothing else. The model
 * picks no question: practice selects its own, adaptively, from the school's
 * approved bank (core/practice). And it sets nothing: the result is shown to
 * the teacher, who sets it with one press through the ordinary route.
 *
 * Classes and ideas are named by index, never by id — the rule concept
 * drafting and paper planning follow.
 */

export const PracticePlan = z.object({
  /** False when the request is not for practice at all; nothing is proposed. */
  understood: z.boolean(),
  /** One sentence to the teacher when `understood` is false, or an assumption worth stating. */
  note: z.string().max(300),
  classIndex: z.number().int().min(0).nullable(),
  /** One practice set per idea. Practice is per concept, never per chapter. */
  conceptIndexes: z.array(z.number().int().min(0)).max(5),
  /** Questions in each set. The builder clamps to what a practice set may be. */
  questionCount: z.number().int().min(1).max(20),
  /** A calendar date, YYYY-MM-DD, or null when the teacher named none. */
  dueOn: z.string().nullable(),
  /** A short line for the students, only if the teacher gave one. */
  studentNote: z.string().max(200),
});

export type PracticePlan = z.infer<typeof PracticePlan>;

export type PracticeContext = {
  organizationId: string;
  userId: string;
  boardName: string;
  /** In the order `classIndex` refers to. */
  classes: { name: string; subjectName: string; gradeLabel: string }[];
  /** In the order `conceptIndexes` refers to. */
  concepts: { name: string; chapterTitle: string; subjectName: string; gradeLabel: string }[];
  request: string;
  /** Today in India, YYYY-MM-DD and the weekday — in the request, never the system prompt. */
  today: string;
};

export function buildSystem(boardName: string): string {
  return `You help a school teacher in India set PRACTICE for a class. Practice is untimed and unmarked: a student answers a handful of questions on one idea and gets the explanation after each one. The teacher describes what they want in a sentence; you turn it into settings. You never choose or write questions — practice picks its own from the questions the teacher has approved.

The board is ${boardName}.

WHAT YOU DECIDE

- classIndex: which of the teacher's classes, by its number in the list. If they name no class and have exactly one, use it. If they name none and have several, pick the one whose subject matches; if that is still ambiguous, set understood to false and ask which class in note.
- conceptIndexes: the ideas to practise, by their numbers in the list, from the class's own subject only. Each idea becomes its own practice set. If they name an idea, pick that one. If they name a whole chapter, pick the ideas listed under that chapter — at most five, the ones most central to it. Never pick an idea from another subject.
- questionCount: questions in each set. What they say; otherwise 6. A set is between 4 and 10.
- dueOn: a date as YYYY-MM-DD, worked out from today's date given in the request. "By Friday" is the coming Friday. No date said: null.
- studentNote: a short line for the students only if the teacher gave one ("before Thursday's lesson"); otherwise an empty string. Never invent one.

WHEN TO REFUSE

If the request is not about practice or homework on ideas, or names a subject none of the classes study, set understood to false, explain in one sentence in note, and fill the other fields with any valid values. Never invent a class or an idea that is not listed.

note: when understood is true, one short sentence stating any assumption you made that the teacher should check (for example, "I took the chapter to mean these two ideas"), or an empty string. The teacher reads it BEFORE anything is set, so never say that you assigned, set or sent anything. Name ideas and classes by their names, never by their numbers in the lists — the teacher never sees the numbers.`;
}

export function buildRequest(context: PracticeContext): string {
  const classes = context.classes
    .map((klass, index) => `[${index}] ${klass.name} — ${klass.subjectName}, ${klass.gradeLabel}`)
    .join("\n");
  const concepts = context.concepts
    .map(
      (concept, index) =>
        `[${index}] ${concept.subjectName}, ${concept.gradeLabel} — ${concept.chapterTitle}: ${concept.name}`,
    )
    .join("\n");
  return `Today is ${context.today}.

THE TEACHER'S CLASSES
${classes}

IDEAS (by chapter)
${concepts}

THE REQUEST
${context.request}`;
}

export async function planPractice(context: PracticeContext): Promise<TaskOutcome<PracticePlan>> {
  return runTask({
    organizationId: context.organizationId,
    userId: context.userId,
    feature: "PRACTICE_PLANNING",
    // One sentence against two lists — the paper planner's tier, for its reason.
    tier: "FAST",
    effort: "low",
    system: buildSystem(context.boardName),
    messages: [{ role: "user", content: buildRequest(context) }],
    schema: PracticePlan,
    schemaName: "PracticePlan",
    maxTokens: 600,
    // The sentence goes to the provider and never into the ledger.
    input: {
      boardName: context.boardName,
      classCount: context.classes.length,
      conceptCount: context.concepts.length,
      requestLength: context.request.length,
    },
    safeFields: ["boardName", "classCount", "conceptCount", "requestLength"],
    // The paper planner's allowance: the same promise, "the AI set it up for me".
    entitlementKey: "ai_generations_per_month",
  });
}
