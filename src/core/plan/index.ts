import "server-only";
import { studentAssignments } from "@/core/attempts/student-view";
import { studentConceptStates } from "@/core/practice";
import { mistakeSummary } from "@/core/mistakes/read";
import { buildPlan, type Plan, type PlanTest } from "./build";

/**
 * The study plan, assembled.
 *
 * All the reading is here; all the deciding is in `build.ts`. The split is what
 * makes the plan testable without a database and arguable without reading a
 * query — the same shape as the recommender and the mastery estimator, and for
 * the same reason: this decides what a fifteen-year-old does with their
 * evening, so the rule has to be inspectable.
 *
 * ---------------------------------------------------------------------------
 * Nothing is stored, and there is no route that ticks an item off
 * ---------------------------------------------------------------------------
 * `studyPlan()` derives everything at read time, exactly as an assignment's
 * status is derived from two timestamps. A stored plan is stale the moment the
 * student practises, and it would need a job to refresh it — with rows that are
 * a lie between ticks.
 *
 * More importantly, a plan with checkboxes measures how tidy somebody is. An
 * item leaves this list when the evidence moves and on nothing else, which is
 * the same rule a learning gap and a mistake already follow. That is not a
 * coincidence; it is the same claim about what evidence is for.
 */

export type Actor = { organizationId: string; userId: string };

export type { Plan, PlanItem, PlanItemKind } from "./build";

export async function studyPlan(
  actor: Actor,
  now = new Date(),
): Promise<Plan> {
  const [assignments, concepts, mistakes] = await Promise.all([
    studentAssignments(actor.organizationId, actor.userId),
    studentConceptStates(actor, now),
    mistakeSummary(actor.organizationId, actor.userId),
  ]);

  const tests: PlanTest[] = assignments.map((assignment) => ({
    assignmentId: assignment.assignmentId,
    title: assignment.title,
    subjectName: assignment.subjectName,
    opensAt: assignment.opensAt,
    closesAt: assignment.closesAt,
    status: assignment.status,
    canStart: assignment.canStart,
    inProgressAttemptId: assignment.inProgressAttemptId,
    attemptsUsed: assignment.attemptsUsed,
  }));

  return buildPlan(
    {
      tests,
      concepts,
      // Retried counts as open: getting the SAME question right again is
      // engagement, not proof, and the bank says so. A plan that quietly
      // dropped it would contradict the page it links to.
      openMistakes: mistakes.open + mistakes.retried,
      mistakeConceptName: mistakes.worst?.conceptName ?? null,
    },
    now,
  );
}
