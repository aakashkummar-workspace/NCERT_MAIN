import "server-only";
import { z } from "zod";
import { runTask, type TaskOutcome } from "../gateway";

/**
 * Proposing concepts for outcomes nothing measures.
 *
 * ---------------------------------------------------------------------------
 * The bottleneck this exists for
 * ---------------------------------------------------------------------------
 * Mastery is measured per CONCEPT; questions are filed against OUTCOMES. The
 * console can now author both and link them, and a full CBSE syllabus is still
 * several hundred concepts of careful judgement — which is the difference
 * between a product that can ship and one that cannot.
 *
 * Grouping related outcome statements into the idea they share is exactly the
 * task a model is good at and a person is slow at. So it drafts, and a platform
 * admin approves — the same shape as question generation, and for the same
 * reason: nothing a model produces here is authoritative, and a concept written
 * without a person reading it would change what every school in the product
 * measures.
 *
 * ---------------------------------------------------------------------------
 * The one AI task with no personal data in it at all
 * ---------------------------------------------------------------------------
 * Every other task in this directory scrubs, uses opaque handles, or withholds
 * something. This one sends learning-outcome statements from a public syllabus
 * and nothing else — no student, no teacher, no organisation, not even a class
 * name. Worth stating rather than assuming, because "there is nothing sensitive
 * here" is a claim somebody should be able to check against the payload.
 */

const Proposal = z.object({
  /**
   * What a student can or cannot DO. Not a chapter title.
   *
   * This ends up as a heatmap column heading, a line in a term report and the
   * subject of "your class is weak on ___", so it has to read as an idea.
   */
  name: z.string().min(3).max(80),
  /** One line, for the person deciding whether to accept it. */
  description: z.string().min(10).max(200),
  /**
   * The outcomes this concept would measure, by the index shown in the prompt.
   *
   * Indexes rather than ids: a model asked to echo a uuid will eventually
   * mistype one, and a mistyped uuid is a link to nothing that looks exactly
   * like a link to something. An index out of range is discarded — the same
   * rule the question validator applies to a verdict pointing at a draft that
   * does not exist.
   */
  outcomeIndexes: z.array(z.number().int().min(0)).min(1).max(12),
  /**
   * Why these belong together, in a sentence.
   *
   * The reviewer is deciding whether the grouping is right, and a list of five
   * outcome codes with no argument is a proposal nobody can evaluate — they
   * either accept everything or nothing.
   */
  rationale: z.string().min(10).max(300),
});

export type Proposal = z.infer<typeof Proposal>;

export const ConceptProposals = z.object({
  /**
   * Empty is a real answer.
   *
   * If the outcomes on offer do not group into anything coherent, saying so
   * beats inventing a bucket. A concept nobody would have written by hand is
   * one that quietly fragments the evidence for the rest.
   */
  proposals: z.array(Proposal).max(12),
});

export type ConceptProposals = z.infer<typeof ConceptProposals>;

export type SuggestContext = {
  organizationId: string;
  userId: string;
  /** The board being authored. Platform work, so it is whichever one asked. */
  boardName: string;
  gradeLabel: string;
  subjectName: string;
  /** Outcomes nothing measures, in the order the indexes refer to. */
  outcomes: { code: string; statement: string; chapterTitle: string }[];
  /** Concepts that already exist in this subject, so nothing is proposed twice. */
  existingNames: string[];
};

export function buildSystem(context: SuggestContext): string {
  return `You are helping author the concept layer of a ${context.boardName} assessment product for ${context.gradeLabel} ${context.subjectName}.

WHAT A CONCEPT IS HERE

A concept is the unit a student's mastery is measured in. It is one idea a student can either do or not do — "Similarity of triangles", "Balancing chemical equations" — and it is deliberately coarser than a learning outcome: the SAME idea is tested by outcomes in several chapters, and measuring per outcome fragments the evidence until no figure has enough behind it to be worth showing.

So the job is to find the ideas that the outcomes below share, and to group the outcomes under them.

WHAT MAKES A GOOD ONE

- It names something a student DOES. "Chapter 6", "Introduction", "Applications of trigonometry" are chapter titles, not concepts.
- It is coarse enough to accumulate evidence. A concept covering one outcome in one chapter will rarely have four answers behind it, and below that threshold this product refuses to show a figure at all — so it will sit on every screen saying "not enough evidence yet" forever.
- It is narrow enough to act on. "Mathematics" is not a concept; a teacher cannot reteach it on Thursday.
- Between three and eight outcomes is the usual shape. One is almost always too few.

WHAT TO REFUSE

Return an empty list rather than inventing a grouping. Outcomes that share nothing are better left uncovered and visible than filed under a concept somebody has to unpick later — an uncovered outcome is a known hole, and a wrong concept is a wrong measurement that looks right.

Do not propose a concept that already exists. These are already in this subject:
${context.existingNames.length > 0 ? context.existingNames.map((name) => `  - ${name}`).join("\n") : "  (none yet)"}

HOW TO WRITE THEM

The name is a noun phrase in sentence case, as a teacher would say it aloud.

The rationale is addressed to the person deciding whether to accept the grouping. Say what these outcomes have in common, in one sentence. Not "these are related".`;
}

export function buildRequest(context: SuggestContext): string {
  const outcomes = context.outcomes
    .map(
      (outcome, index) =>
        `[${index}] (${outcome.code}, ${outcome.chapterTitle}) ${outcome.statement}`,
    )
    .join("\n");

  return `Here are ${context.outcomes.length} learning outcomes that no concept currently measures. Group the ones that share an idea, and refer to them by the index in brackets.

Not every outcome has to be used. Leaving one out is better than forcing it somewhere.

${outcomes}`;
}

export async function suggestConcepts(
  context: SuggestContext,
): Promise<TaskOutcome<ConceptProposals>> {
  return runTask({
    organizationId: context.organizationId,
    userId: context.userId,
    feature: "RECOMMENDATION",
    // A judgement over a long list of statements, written once and reviewed by
    // a person. BALANCED is the tier for that — FAST reads against a fixed
    // rubric, and this has no rubric, only taste.
    tier: "BALANCED",
    effort: "high",
    system: buildSystem(context),
    messages: [{ role: "user", content: buildRequest(context) }],
    schema: ConceptProposals,
    schemaName: "ConceptProposals",
    maxTokens: 220 * Math.min(context.outcomes.length, 40) + 600,
    input: {
      boardName: context.boardName,
      gradeLabel: context.gradeLabel,
      subjectName: context.subjectName,
      outcomeCount: context.outcomes.length,
      existingCount: context.existingNames.length,
    },
    safeFields: [
      "boardName",
      "gradeLabel",
      "subjectName",
      "outcomeCount",
      "existingCount",
    ],
    // Deliberately NOT metered against any customer allowance. This is platform
    // curriculum work: it is done once, by us, and every school benefits from
    // the result. Charging a teacher's generation quota for it would be
    // charging them for our own authoring.
  });
}
