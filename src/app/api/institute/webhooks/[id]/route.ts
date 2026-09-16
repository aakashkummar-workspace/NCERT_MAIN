import { z } from "zod";
import { can } from "@/core/billing/entitlements";
import { updateEndpoint } from "@/core/webhooks/endpoints";
import { guard } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  active: z.boolean().optional(),
  events: z.array(z.string()).optional(),
  url: z.string().optional(),
});

/**
 * Change an endpoint: switch it off, change what it is subscribed to, or fix
 * the address.
 *
 * There is no DELETE. An endpoint is switched off, which stops delivery
 * immediately — the check happens at send time, so even a queued backlog stops
 * — and leaves the delivery log intact. Deleting the row would delete the
 * answer to "did the marks ever reach the office", which is the only question
 * anybody asks about an integration after it has gone wrong.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:update");
  if (!check.ok) return check.response;

  const allowed = await can(check.session.actor.organizationId, "admin_console");
  if (!allowed.allowed) return fail("NOT_FOUND", "We could not find that.");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const { id } = await params;
  const result = await updateEndpoint(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
    parsed.data,
  );
  if (!result.ok) return fail("VALIDATION_FAILED", result.message);

  return ok(result);
}
