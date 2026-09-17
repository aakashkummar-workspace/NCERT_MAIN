import { z } from "zod";
import { setOrganizationPlan } from "@/core/platform/plans";
import { expireBrand } from "@/app/_branding/cache-tag";
import { guardPlatform } from "../../../../_lib/platform";
import { fail, failValidation, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ planCode: z.string().min(1).max(64) });

/** Put an organisation on a plan. Platform admins only; audited on both sides. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardPlatform();
  if (!check.ok) return check.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { id } = await params;
  const result = await setOrganizationPlan(
    { organizationId: check.session.actor.organizationId, userId: check.session.actor.userId },
    id,
    parsed.data.planCode,
  );
  if (!result.ok) {
    return fail(result.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_FAILED", result.message);
  }
  // A plan decides whether branding shows at all.
  expireBrand(id);
  return ok(result);
}
