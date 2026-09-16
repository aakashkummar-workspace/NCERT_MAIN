import { timingSafeEqual } from "node:crypto";
import { runWebhookDeliveries } from "@/core/webhooks/runner";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deliver whatever the outbox is holding.
 *
 * The same shared-secret gate as the expiry sweep and the mastery refresh, and
 * the same rule: with `CRON_SECRET` unset this refuses everything, so a deploy
 * that forgets the variable fails loudly rather than leaving an endpoint that
 * writes to every tenant. A wrong secret gets 404, not 403 — a 403 confirms the
 * route is there and worth guessing at.
 *
 * Every pass is a 200, including the one where a tenant threw. The pass itself
 * completed, and a scheduler that retried the whole thing because one
 * organization failed would redo the deliveries that had already succeeded —
 * which for a webhook means a school importing the same marks twice.
 *
 * Run it every minute or two. Nothing here is time-critical: an event delivered
 * ninety seconds late is invisible to an office, and delivering it in the
 * transaction that produced it is what this whole design exists to avoid.
 */
export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return fail(
      "INTERNAL",
      "The scheduled job is not configured on this deployment.",
    );
  }

  const offered = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (!offered || !constantTimeEquals(offered, expected)) {
    return fail("NOT_FOUND", "We could not find that.");
  }

  const report = await runWebhookDeliveries();
  return ok(report);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a leak of the
  // secret's length — so pad to a common size and compare lengths after.
  const size = Math.max(left.length, right.length);
  const padLeft = Buffer.alloc(size);
  const padRight = Buffer.alloc(size);
  left.copy(padLeft);
  right.copy(padRight);
  return timingSafeEqual(padLeft, padRight) && left.length === right.length;
}
