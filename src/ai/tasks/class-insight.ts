import "server-only";
import { z } from "zod";
import { runTask, type TaskOutcome } from "../gateway";

/**
 * One paragraph about a class, for a teacher who has thirty seconds.
 *
 * ---------------------------------------------------------------------------
 * Why this is worth an AI call at all
 * ---------------------------------------------------------------------------
 * Everything it says is already on the analytics page as numbers. The value is
 * not new information — it is the sentence a teacher would have written after
 * ten minutes of reading the grid, handed to them before they start.
 *
 * Which makes the failure mode obvious: a narrative that restates the numbers
 * ("the class averaged 62%") is worse than no narrative, because it costs money
 * and a teacher's attention to tell them what they can already see. The prompt
 * asks for the *reading* of the numbers — what to do on Monday and why.
 *
 * ---------------------------------------------------------------------------
 * What goes to the model
 * ---------------------------------------------------------------------------
 * Concept names, band counts, estimates, gap severities. No student name, no
 * roll number, no organization, no school. Individual students appear as `S_7f3a`
 * or not at all — and for a class-level narrative they do not need to appear at
 * all, so they do not.
 */

export const ClassInsight = z.object({
  /** Two or three sentences. A page of prose is a page nobody reads. */
  summary: z.string().min(40).max(600),
  /** The single thing to do first, if there is one worth naming. */
  nextStep: z.string().max(240).nullable(),
  /** What is going well. Named because a report that is only bad news gets ignored. */
  strength: z.string().max(240).nullable(),
});

export type ClassInsight = z.infer<typeof ClassInsight>;

export type InsightContext = {
  organizationId: string;
  userId: string;
  subjectName: string;
  gradeLabel: string;
  studentCount: number;
  concepts: {
    name: string;
    measured: number;
    total: number;
    meanEstimate: number | null;
    counts: Record<string, number>;
  }[];
  gaps: {
    concept: string;
    severity: string;
    affected: number;
    measured: number;
    rootCause: string | null;
  }[];
  /** The board. Below the cache breakpoint, in the request — see buildSystem. */
  boardName: string;
};

export function buildSystem(): string {
  return `You write one short note for a school teacher in India about how their class is doing. The board they teach is named in the request; it is there rather than here so that one cached prefix serves every school.

The teacher can already see the numbers. Do not restate them. Tell them what the numbers MEAN and what to do about it — the sentence they would have written themselves after ten minutes of reading the table.

RULES
- Two or three sentences for the summary. Not a report.
- Name concepts by name. "Similarity of triangles" tells a teacher where to go; "some topics" does not.
- Where a gap has a root cause, say to teach the root cause first and why. That is the most useful thing you can say.
- Say what is going well, in one clause, if anything is. A note that is only bad news gets skimmed after the second week. A strength is something MEASURED going well — a concept the students behind it are secure on. "No gaps detected" or "nothing flagged yet" is an absence of evidence, not a strength; when nothing measured is going well, leave strength empty.
- Never invent a number, a student, or a cause. If the evidence is thin, say the evidence is thin.
- No greeting, no sign-off, no "as an AI".
- Plain English for an Indian classroom. No jargon, no "leverage", no "actionable insights".

You will be given concept-level figures with the count of students behind each one. A figure over three students is not a class trend and you should say so rather than draw a conclusion from it.`;
}

export function buildRequest(context: InsightContext): string {
  const concepts = context.concepts
    .map((concept) => {
      const bands = Object.entries(concept.counts)
        .filter(([, count]) => count > 0)
        .map(([band, count]) => `${count} ${band.toLowerCase()}`)
        .join(", ");
      const mean =
        concept.meanEstimate === null
          ? "no class figure (too few measured)"
          : `mean ${Math.round(concept.meanEstimate * 100)}%`;
      return `- ${concept.name}: ${mean}, ${concept.measured} of ${concept.total} measured — ${bands}`;
    })
    .join("\n");

  const gaps =
    context.gaps.length === 0
      ? "None detected."
      : context.gaps
          .map(
            (gap) =>
              `- ${gap.concept} (${gap.severity}): ${gap.affected} of ${gap.measured} measured students below the line` +
              (gap.rootCause ? `; they are also weak on ${gap.rootCause}, which it builds on` : ""),
          )
          .join("\n");

  return `${context.boardName}. ${context.gradeLabel} ${context.subjectName}, ${context.studentCount} students.

CONCEPTS
${concepts || "Nothing measured yet."}

GAPS
${gaps}`;
}

export async function classInsight(
  context: InsightContext,
): Promise<TaskOutcome<ClassInsight>> {
  return runTask({
    organizationId: context.organizationId,
    userId: context.userId,
    feature: "PERFORMANCE_ANALYSIS",
    // A judgement about a whole class, which a teacher may act on for thirty
    // students. Worth the balanced tier; not worth the deep one, because the
    // reasoning is short and the inputs are already summarised.
    tier: "BALANCED",
    effort: "medium",
    system: buildSystem(),
    messages: [{ role: "user", content: buildRequest(context) }],
    schema: ClassInsight,
    schemaName: "ClassInsight",
    maxTokens: 800,
    // Concept names and counts. No student, no teacher, no school.
    input: {
      boardName: context.boardName,
      subjectName: context.subjectName,
      gradeLabel: context.gradeLabel,
      studentCount: context.studentCount,
      conceptCount: context.concepts.length,
      gapCount: context.gaps.length,
    },
    safeFields: [
      "boardName",
      "subjectName",
      "gradeLabel",
      "studentCount",
      "conceptCount",
      "gapCount",
    ],
  });
}
