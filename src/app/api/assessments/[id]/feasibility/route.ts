import { checkFeasibility, getAssessment } from "@/core/assessments";
import { describeShortfalls } from "@/core/assessments/blueprint";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";
import { BlueprintSchema } from "../route";

export const runtime = "nodejs";

/**
 * Can the bank supply this blueprint?
 *
 * Answered at step 3, while the mix is still being chosen — not at step 5,
 * when changing it costs the teacher the evening they have already spent.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const assessment = await getAssessment(check.session.actor.organizationId, id);
  if (!assessment) return notFound("assessment");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = BlueprintSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const feasibility = await checkFeasibility(
    check.session.actor.organizationId,
    assessment.subjectId,
    parsed.data as Parameters<typeof checkFeasibility>[2],
  );

  return ok({ ...feasibility, messages: describeShortfalls(feasibility) });
}
