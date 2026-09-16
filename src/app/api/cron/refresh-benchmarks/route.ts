import { timingSafeEqual } from "node:crypto";
import { refreshContributions } from "@/core/benchmarks";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recompute what every opted-in school contributes to the benchmarks.
 *
 * Nightly, and AFTER the mastery refresh: a contribution is a mean over
 * estimates, so computing it before the estimates have been decayed would
 * publish yesterday's confidence to every other school.
 *
 * Same shared-secret gate as the other jobs, and the same rule: with
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

  return ok(await refreshContributions());
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
