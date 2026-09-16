import { timingSafeEqual } from "node:crypto";
import { refreshStaleMastery } from "@/core/mastery/sync";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recompute estimates the clock has made stale.
 *
 * Same shared-secret gate as the expiry sweep, and the same rule: with
 * CRON_SECRET unset this refuses everything, so a deploy that forgets the
 * variable fails loudly rather than leaving an endpoint that writes to every
 * tenant.
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

  const report = await refreshStaleMastery();
  return ok(report);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  const size = Math.max(left.length, right.length);
  const padLeft = Buffer.alloc(size);
  const padRight = Buffer.alloc(size);
  left.copy(padLeft);
  right.copy(padRight);
  return timingSafeEqual(padLeft, padRight) && left.length === right.length;
}
