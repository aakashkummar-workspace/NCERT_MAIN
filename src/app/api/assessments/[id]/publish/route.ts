import { publishAssessment } from "@/core/assessments";
import { guard } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const result = await publishAssessment(check.session.actor, id);

  if (!result.ok) {
    // The problems are the point. A refusal that does not say what to change
    // is a dead end.
    return fail(
      "CONFLICT",
      result.problems[0] ?? "It is not ready to publish.",
      { problems: result.problems },
    );
  }

  return ok({ published: true });
}
