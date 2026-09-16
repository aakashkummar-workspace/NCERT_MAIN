import { z } from "zod";
import { can } from "@/core/billing/entitlements";
import { createEndpoint } from "@/core/webhooks/endpoints";
import { guard } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  url: z.string().min(1),
  label: z.string().min(1),
  events: z.array(z.string()).min(1),
});

/**
 * Add an endpoint.
 *
 * Guarded twice, exactly as the staff routes are: `organization:update` says
 * this person may change how the organization is configured — an integration
 * is configuration, not teaching — and `admin_console` says the plan includes
 * the console at all. Neither implies the other.
 *
 * The response carries the signing secret, and it is the only response in the
 * product that ever will. See the comment on `WebhookEndpoint.secret`.
 */
export async function POST(request: Request) {
  const check = await guard("organization:update");
  if (!check.ok) return check.response;

  const allowed = await can(check.session.actor.organizationId, "admin_console");
  if (!allowed.allowed) return fail("NOT_FOUND", "We could not find that.");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await createEndpoint(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    parsed.data,
  );
  if (!result.ok) return fail("VALIDATION_FAILED", result.message);

  return ok(result, { status: 201 });
}
