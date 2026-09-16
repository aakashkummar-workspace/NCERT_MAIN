import { insightForClass } from "@/core/analytics/insight";
import { guard } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * One paragraph about a class.
 *
 * A POST rather than a GET, because it spends money. A page that produced a
 * narrative on every load would bill a teacher for refreshing.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const result = await insightForClass(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    id,
  );

  if (!result.ok) {
    return fail(
      result.code === "NOT_FOUND"
        ? "NOT_FOUND"
        : result.code === "PLAN"
          ? "CONFLICT"
          : "VALIDATION_FAILED",
      result.message,
    );
  }

  return ok(result);
}
