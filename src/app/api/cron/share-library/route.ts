import { timingSafeEqual } from "node:crypto";
import { syncLibrary } from "@/core/library/sync";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Copies the shared question library into the next few CBSE schools waiting
 * for it. Called by the scheduler, never by a browser — authenticated by
 * CRON_SECRET alone, exactly like the other scheduled jobs.
 */
export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return fail("INTERNAL", "The scheduled job is not configured on this deployment.");
  }
  const offered = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!offered || !constantTimeEquals(offered, expected)) {
    return fail("NOT_FOUND", "We could not find that.");
  }

  // A school that failed is reported with a 200, as the sweep does: the run
  // completed, and retrying it whole would redo the schools that succeeded.
  return ok(await syncLibrary());
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
