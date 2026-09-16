import "server-only";
import { classInsight, type ClassInsight } from "@/ai/tasks/class-insight";
import { classOverview } from "./class";
import { classGaps } from "@/core/gaps/read";
import { organizationBoard } from "@/core/organizations";
import { can } from "@/core/billing/entitlements";

/**
 * The narrative, assembled from what the analytics page already knows.
 *
 * Nothing is fetched specially for the model: it reads the same overview and
 * the same gap list a teacher is looking at. That is deliberate — a narrative
 * computed from a different query than the page it sits on will eventually
 * disagree with it, and the teacher will believe the prose.
 */

export type Actor = { organizationId: string; userId: string };

export type InsightResult =
  | { ok: true; insight: ClassInsight; costMicros: number }
  | { ok: false; code: string; message: string };

/**
 * Whether the plan includes a model's reading of the class.
 *
 * There is no entitlement of its own, so it rides on the Copilot's: the same
 * kind of work (a model reasoning over a class's figures), and the key that
 * says whether a plan includes AI analysis at all. Free has no row, and a
 * missing entitlement is "not included", never "unlimited" — the narrative used
 * to reach the provider on Free because nothing asked. A Copilot allowance
 * that is merely used up does not close this: the narrative is not metered
 * against it, and a teacher who asked their fifty questions still has a plan
 * that includes it.
 */
export async function insightIncluded(organizationId: string): Promise<boolean> {
  const verdict = await can(organizationId, "copilot_questions_per_month");
  return verdict.allowed || verdict.reason === "limit-reached";
}

export async function insightForClass(
  actor: Actor,
  classId: string,
): Promise<InsightResult> {
  const [overview, gaps] = await Promise.all([
    classOverview(actor.organizationId, classId),
    classGaps(actor.organizationId, classId),
  ]);

  if (!overview) {
    return { ok: false, code: "NOT_FOUND", message: "We could not find that class." };
  }

  // The plan before the data and before the provider — the Copilot's order,
  // for the Copilot's reason: a teacher on Free told "nothing measured yet" is
  // told their data is the problem when their plan is.
  if (!(await insightIncluded(actor.organizationId))) {
    return {
      ok: false,
      code: "PLAN",
      message:
        "A written summary of the class is not part of your plan. The figures on this page are all still here — get in touch and we will move you.",
    };
  }

  if (overview.concepts.length === 0) {
    // Refused rather than attempted. A narrative about nothing is a paragraph
    // of hedging, and a teacher who reads one learns the feature has nothing
    // to say.
    return {
      ok: false,
      code: "NOTHING_MEASURED",
      message:
        "Nothing has been measured for this class yet, so there is nothing to summarise. This fills in once a paper has been marked.",
    };
  }

  // The board comes from the organization, like every other curriculum fact.
  const board = await organizationBoard(actor.organizationId);

  const outcome = await classInsight({
    organizationId: actor.organizationId,
    userId: actor.userId,
    boardName: board.name,
    subjectName: overview.subjectName,
    gradeLabel: overview.className,
    studentCount: overview.students,
    concepts: overview.concepts.map((concept) => ({
      name: concept.conceptName,
      measured: concept.measured,
      total: concept.total,
      meanEstimate: concept.meanEstimate,
      counts: concept.counts,
    })),
    gaps: gaps.map((gap) => ({
      concept: gap.conceptName,
      severity: gap.severity,
      affected: gap.affectedStudentCount,
      measured: gap.measuredStudentCount,
      rootCause: gap.rootCauseName,
    })),
  });

  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }

  return { ok: true, insight: outcome.value, costMicros: outcome.costMicros };
}
