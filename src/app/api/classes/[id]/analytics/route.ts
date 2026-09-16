import { classOverview } from "@/core/analytics/class";
import { guard, notFound } from "../../../_lib/guard";
import { ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * What a class knows, concept by concept.
 *
 * Every figure carries the denominator it was computed over, and a concept
 * with too few measured students reports `meanEstimate: null` rather than an
 * average of the three who happened to sit the last paper.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const overview = await classOverview(check.session.actor.organizationId, id);
  if (!overview) return notFound("class");

  return ok(overview);
}
