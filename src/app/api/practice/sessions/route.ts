import { z } from "zod";
import { startPractice } from "@/core/practice";
import { guardStudent } from "../../_lib/student";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  conceptId: z.string().uuid(),
  source: z
    .enum(["RECOMMENDED", "MISTAKE_REVIEW", "SELF_SELECTED", "ASSIGNED"])
    .default("SELF_SELECTED"),
  questionCount: z.number().int().min(1).max(20).optional(),
});

/**
 * Start a set.
 *
 * An unfinished set on the same concept is resumed rather than duplicated — a
 * student who backgrounds the tab and taps again should not find two half-done
 * sets, and on a phone that happens constantly.
 */
export async function POST(request: Request) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await startPractice(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    parsed.data,
  );
  if (!result.ok) return fail("CONFLICT", result.message);

  return ok(result, { status: 201 });
}
