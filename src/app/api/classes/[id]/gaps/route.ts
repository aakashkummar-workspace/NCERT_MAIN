import { classGaps } from "@/core/gaps/read";
import { guard } from "../../../_lib/guard";
import { ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * What to reteach, prioritised.
 *
 * Persisting first — a gap that survived an intervention says the thing that
 * was tried did not work, which is the most important line on the page.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const includeResolved =
    new URL(request.url).searchParams.get("includeResolved") === "true";

  const gaps = await classGaps(check.session.actor.organizationId, id, {
    includeResolved,
  });
  return ok({ gaps });
}
