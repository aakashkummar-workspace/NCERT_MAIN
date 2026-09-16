import { timingSafeEqual } from "node:crypto";
import { sweepAllOrganizations } from "@/core/attempts/sweep";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the expiry sweep. Called by the scheduler, never by a browser.
 *
 * Authenticated by a shared secret rather than a session, because there is no
 * user here — and *only* by a shared secret: with `CRON_SECRET` unset this
 * route refuses everything, so a deploy that forgets the variable fails loudly
 * instead of leaving an unauthenticated endpoint that writes to every tenant.
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

  const report = await sweepAllOrganizations();

  // A tenant that failed is reported with a 200: the run itself completed, and
  // a scheduler that retries the whole sweep because one organization threw
  // would redo work that already succeeded.
  return ok(report);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a leak of the
  // secret's length — so compare lengths only after the buffers are padded to
  // the same size.
  const size = Math.max(left.length, right.length);
  const padLeft = Buffer.alloc(size);
  const padRight = Buffer.alloc(size);
  left.copy(padLeft);
  right.copy(padRight);
  return timingSafeEqual(padLeft, padRight) && left.length === right.length;
}
