import { z } from "zod";
import { startPractice } from "@/core/practice";
import { openForStudent } from "@/core/practice/assigned";
import { guardStudent } from "../../_lib/student";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  conceptId: z.string().uuid(),
  source: z
    .enum(["RECOMMENDED", "MISTAKE_REVIEW", "SELF_SELECTED", "ASSIGNED"])
    .default("SELF_SELECTED"),
  questionCount: z.number().int().min(1).max(20).optional(),
  /**
   * The teacher instruction this set answers, when the student tapped one.
   *
   * It is VERIFIED below rather than trusted: an id in a request body is a
   * claim, and this one decides whose homework is recorded as done. The row it
   * names must belong to a class the student is actually enrolled in.
   */
  assignedPracticeId: z.string().uuid().optional(),
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

  const { organizationId, userId } = check.session.actor;

  // The instruction has to be one of THEIRS. Without this, a student could
  // name any assignment id and have it recorded as done — the same reason no
  // route accepts an organization id from a body.
  let assignedPracticeId: string | null = null;
  if (parsed.data.assignedPracticeId) {
    const theirs = await openForStudent(organizationId, userId);
    const match = theirs.find((row) => row.id === parsed.data.assignedPracticeId);
    if (!match) return fail("NOT_FOUND", "We could not find that practice set.");
    // And it has to be for the concept it says it is.
    if (match.conceptId !== parsed.data.conceptId) {
      return fail("VALIDATION_FAILED", "That set is about a different idea.");
    }
    assignedPracticeId = match.id;
  }

  const result = await startPractice(
    { organizationId, userId },
    { ...parsed.data, assignedPracticeId },
  );
  if (!result.ok) return fail("CONFLICT", result.message);

  return ok(result, { status: 201 });
}
