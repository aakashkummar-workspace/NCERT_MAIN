import { timingSafeEqual } from "node:crypto";
import { sendWeeklyDigests } from "@/core/digest/jobs";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The weekly WhatsApp digest for parents who asked for one. Schedule it once a
 * week (Sunday evening IST). Same shared-secret gate as every other job: with
 * CRON_SECRET unset it refuses everything. Safe to run twice — the ledger is
 * keyed by the week.
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
  return ok(await sendWeeklyDigests());
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
