import "server-only";
import { platformPrisma } from "@/db/platform";
import { suggestConcepts, type Proposal } from "@/ai/tasks/suggest-concepts";
import { checkConceptName } from "./concept-rules";
import { uncoveredOutcomes } from "./concept-admin";

/**
 * Drafting the concept layer, for a person to approve.
 *
 * ---------------------------------------------------------------------------
 * Two gates, in this order — the same shape as generated questions
 * ---------------------------------------------------------------------------
 * A model's proposal is checked deterministically here BEFORE it reaches the
 * reviewer, and only then does a person decide. The order matters: a reviewer
 * reading eight proposals of which three are malformed learns to skim, and a
 * reviewer who skims is not a gate at all.
 *
 * What gets dropped without asking anybody:
 *
 *   - a proposal referring to an outcome index that was not offered. A model
 *     that renumbers lands its grouping on the wrong outcomes, which is worse
 *     than no grouping because it looks deliberate. Same rule the question
 *     validator applies to a verdict pointing at a draft that does not exist.
 *   - a name that already exists. Two concepts with one name are
 *     indistinguishable on a heatmap column.
 *   - a name the pure checker rejects outright.
 *   - a proposal left with no outcomes after the invalid indexes are removed.
 *
 * What is FLAGGED and still shown, because it is a judgement rather than a
 * fault: a single-outcome grouping, and a name that reads like a chapter.
 *
 * ---------------------------------------------------------------------------
 * Nothing here writes anything
 * ---------------------------------------------------------------------------
 * This module proposes. `createConceptWithOutcomes` in `concept-admin.ts` is
 * what writes, and it runs when a person presses a button — a concept created
 * without somebody reading it would change what every school measures.
 */

export type Draft = {
  name: string;
  description: string;
  rationale: string;
  outcomes: { id: string; code: string; statement: string; chapterTitle: string }[];
  /** Advice for the reviewer. Never a reason to hide the draft. */
  flags: string[];
};

export type SuggestResult =
  | { ok: true; drafts: Draft[]; considered: number; discarded: number }
  | { ok: false; reason: "nothing-uncovered" | "unavailable"; message: string };

/** More than this in one call and the model is being asked to hold too much. */
export const MAX_OUTCOMES_PER_CALL = 40;

export async function draftConcepts(
  actor: { organizationId: string; userId: string },
  input: { subjectId: string },
): Promise<SuggestResult> {
  const subject = await platformPrisma.subject.findUnique({
    where: { id: input.subjectId },
    include: { grade: { include: { board: true } } },
  });
  if (!subject) {
    return {
      ok: false,
      reason: "nothing-uncovered",
      message: "We could not find that subject.",
    };
  }

  const uncovered = await uncoveredOutcomes(input.subjectId, MAX_OUTCOMES_PER_CALL);
  if (uncovered.length === 0) {
    // Refused before the call. Paying a model to be told there is nothing to
    // group is the worst outcome available.
    return {
      ok: false,
      reason: "nothing-uncovered",
      message: `Every outcome in ${subject.name} is already measured by a concept. There is nothing to propose.`,
    };
  }

  // Existing names, so nothing is proposed twice — and so the reviewer is not
  // asked to spot a duplicate the product could have spotted.
  const existing = await platformPrisma.concept.findMany({
    where: {
      outcomes: {
        some: { outcome: { topic: { chapter: { subjectId: input.subjectId } } } },
      },
    },
    select: { name: true },
  });
  const everyName = await platformPrisma.concept.findMany({ select: { name: true } });
  const takenNames = new Set(
    everyName.map((concept) => concept.name.trim().toLowerCase()),
  );

  const outcome = await suggestConcepts({
    organizationId: actor.organizationId,
    userId: actor.userId,
    // Platform authoring, so the board is whichever tree this subject sits in
    // — not the admin's own organization.
    boardName: subject.grade.board.name,
    gradeLabel: subject.grade.label,
    subjectName: subject.name,
    outcomes: uncovered.map((row) => ({
      code: row.code,
      statement: row.statement,
      chapterTitle: row.chapterTitle,
    })),
    existingNames: existing.map((concept) => concept.name),
  });

  if (!outcome.ok) {
    // The gateway's wording, never the provider's — and never a throw: no AI
    // call is on a blocking path, and an authoring screen that errors is an
    // authoring screen nobody opens twice.
    return { ok: false, reason: "unavailable", message: outcome.message };
  }

  const drafts: Draft[] = [];
  let discarded = 0;

  for (const proposal of outcome.value.proposals) {
    const draft = accept(proposal, uncovered, takenNames);
    if (draft === null) {
      discarded++;
      continue;
    }
    // A model proposing the same name twice in one batch is the same problem as
    // proposing one that already exists.
    takenNames.add(draft.name.trim().toLowerCase());
    drafts.push(draft);
  }

  return {
    ok: true,
    drafts,
    considered: outcome.value.proposals.length,
    discarded,
  };
}

/** How few outcomes make a concept worth flagging to the reviewer. */
export const THIN_GROUPING = 2;

function accept(
  proposal: Proposal,
  offered: {
    id: string;
    code: string;
    statement: string;
    chapterTitle: string;
  }[],
  takenNames: Set<string>,
): Draft | null {
  const name = proposal.name.trim();

  if (checkConceptName(name).some((problem) => problem.severity === "error")) {
    return null;
  }
  if (takenNames.has(name.toLowerCase())) return null;

  // Indexes the prompt actually offered, de-duplicated. An index out of range
  // is dropped rather than clamped: clamping would silently attach the grouping
  // to a different outcome, which is the failure mode this check exists for.
  const seen = new Set<number>();
  const outcomes: Draft["outcomes"] = [];
  for (const index of proposal.outcomeIndexes) {
    if (index < 0 || index >= offered.length) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    const row = offered[index]!;
    outcomes.push({
      id: row.id,
      code: row.code,
      statement: row.statement,
      chapterTitle: row.chapterTitle,
    });
  }
  if (outcomes.length === 0) return null;

  const flags: string[] = [];
  if (outcomes.length < THIN_GROUPING) {
    // Shown, not hidden: sometimes one outcome really is its own idea. But a
    // concept with one outcome behind it will rarely reach the evidence
    // threshold, and will then sit on every screen saying "not enough evidence
    // yet" forever.
    flags.push(
      "Only one outcome. This will rarely gather enough evidence to show a figure.",
    );
  }
  for (const problem of checkConceptName(name)) {
    if (problem.severity === "warning") flags.push(problem.message);
  }
  if (proposal.outcomeIndexes.length !== outcomes.length) {
    // Said out loud rather than silently trimmed: a reviewer should know the
    // grouping they are looking at is not quite the one that was proposed.
    flags.push(
      "Some of the outcomes it named did not exist and were dropped from this grouping.",
    );
  }

  return {
    name,
    description: proposal.description.trim(),
    rationale: proposal.rationale.trim(),
    outcomes,
    flags,
  };
}
