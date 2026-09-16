import { z } from "zod";
import { saveAnswers } from "@/core/attempts";
import { guardStudent } from "../../../_lib/student";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const ResponseSchema = z.union([
  z.object({ kind: z.literal("choice"), keys: z.array(z.string()).max(8) }),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  z.object({ kind: z.literal("numeric"), value: z.number() }),
  z.object({ kind: z.literal("text"), value: z.string().max(4000) }),
  z.null(),
]);

const Body = z.object({
  answers: z
    .array(
      z.object({
        assessmentQuestionId: z.uuid(),
        response: ResponseSchema,
        markedForReview: z.boolean().optional(),
        timeSpentSeconds: z.number().int().min(0).max(86_400).optional(),
        // A running total from the player, counted per navigation — never per
        // save. See `AnswerPatch.visitCount`.
        visitCount: z.number().int().min(0).max(10_000).optional(),
        // Monotonic per question, from the client. This is what makes a late
        // batch after a reconnect harmless.
        clientSeq: z.number().int().min(0),
      }),
    )
    .max(200),
});

/**
 * Autosave.
 *
 * Deliberately generous: a student mid-exam is never blocked and never loses
 * work, so this route accepts a stale batch (and ignores it) rather than
 * erroring, and accepts a flush after submission rather than telling a client
 * something it cannot act on.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const { id } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await saveAnswers(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    id,
    parsed.data.answers,
  );
  if (!result) return fail("NOT_FOUND", "We could not find that test.");

  return ok(result);
}
