import { timingSafeEqual } from "node:crypto";
import { classifyPendingMistakes } from "@/core/mistakes/sync";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Type the mistakes a rule could not, nightly.
 *
 * The highest-volume AI operation in the product, and the reason it is a
 * scheduled job rather than part of submission: nothing here needs to happen
 * within the second. A student opening their bank an hour after a test sees the
 * question, their answer, the marks and the explanation whether or not this has
 * run — the type is the extra, and the card says so plainly when it is missing.
 *
 * Same shared-secret gate as the other two jobs, and the same rule: with
 * CRON_SECRET unset it refuses everything, so a deploy that forgets the
 * variable fails loudly rather than leaving an endpoint that spends money in
 * every tenant.
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

  const report = await classifyPendingMistakes();
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
