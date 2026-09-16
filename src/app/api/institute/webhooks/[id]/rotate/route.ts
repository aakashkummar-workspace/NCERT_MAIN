import { can } from "@/core/billing/entitlements";
import { rotateSecret } from "@/core/webhooks/endpoints";
import { guard } from "../../../../_lib/guard";
import { fail, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Issue a new signing secret and show it once.
 *
 * This is the ONLY recovery path for a lost secret, and that is deliberate.
 * The alternative — a route that reveals the stored one — would exist to save
 * two minutes of reconfiguration and would be a permanent way to lift every
 * integration key in an organization with one borrowed session.
 *
 * Rotating takes effect on the next delivery, so there is a window in which the
 * receiver is still checking against the old key and will reject what arrives.
 * That is honest rather than avoidable: two valid secrets at once is a second
 * key to keep, to expire and to forget to expire. The screen says to paste the
 * new one in straight away, and a rejection during the gap shows up in the log
 * as a 401 with the sentence that names exactly this cause.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:update");
  if (!check.ok) return check.response;

  const allowed = await can(check.session.actor.organizationId, "admin_console");
  if (!allowed.allowed) return fail("NOT_FOUND", "We could not find that.");

  const { id } = await params;
  const result = await rotateSecret(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
  );
  if (!result.ok) return fail("NOT_FOUND", result.message);

  return ok(result);
}
