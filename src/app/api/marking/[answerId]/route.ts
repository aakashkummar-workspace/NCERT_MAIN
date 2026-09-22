import { z } from "zod";
import { awardByRubric, awardMarks } from "@/core/results/marking";
import { guard } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  // A number, never a string. "3" and "" both coerce to something plausible,
  // and one of those is a zero nobody typed.
  //
  // Optional now: a question with a mark scheme is marked by criterion, and the
  // total is derived from those. Sending both would let a marker disagree with
  // their own breakdown, so the two are mutually exclusive below.
  awardedMarks: z.number().min(0).max(100).optional(),
  scores: z
    .array(
      z.object({
        criterionId: z.string().min(1).max(64),
        marks: z.number().min(0).max(100),
        note: z.string().max(500).nullable().optional(),
      }),
    )
    .min(1)
    .max(8)
    .optional(),
  feedback: z.string().max(2000).nullable().optional(),
  /** Built from a model's draft: stamped AI_ASSISTED. Still the teacher's mark. */
  assisted: z.boolean().optional(),
});

/**
 * Award marks to one written answer.
 *
 * One answer per request, deliberately. A marker works down a list and each
 * decision should land on its own — a batch that fails halfway leaves the
 * teacher guessing which marks were saved.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ answerId: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { answerId } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const actor = {
    organizationId: check.session.actor.organizationId,
    userId: check.session.actor.userId,
    role: check.session.actor.role,
  };

  // Exactly one of the two. A request carrying both is a client that has not
  // decided which it is doing, and whichever the server picked would be a total
  // the marker did not intend.
  const hasScores = Array.isArray(parsed.data.scores);
  const hasTotal = parsed.data.awardedMarks !== undefined;
  if (hasScores === hasTotal) {
    return fail(
      "VALIDATION_FAILED",
      "Send either a total or a mark for each criterion, not both.",
    );
  }

  const options = { assisted: parsed.data.assisted === true };
  const result = hasScores
    ? await awardByRubric(actor, answerId, parsed.data.scores!, parsed.data.feedback, options)
    : await awardMarks(actor, answerId, parsed.data.awardedMarks!, parsed.data.feedback, options);

  // A mark outside the question's range is the teacher's mistake to see, not
  // something to clamp silently.
  if (!result.ok) return fail("VALIDATION_FAILED", result.message);

  return ok(result);
}
