import { z } from "zod";
import { retryMistake } from "@/core/mistakes/read";
import { guardStudent } from "../../../../_lib/student";
import { fail, failValidation, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  response: z.union([
    z.object({ kind: z.literal("choice"), keys: z.array(z.string()).max(8) }),
    z.object({ kind: z.literal("boolean"), value: z.boolean() }),
    z.object({ kind: z.literal("numeric"), value: z.number() }),
    z.object({ kind: z.literal("text"), value: z.string().max(4000) }),
  ]),
  /**
   * The key the device minted before this request left it.
   *
   * Optional: a caller without one gets the old behaviour, which counts every
   * call as a retry. With one, a replay of the same retry returns the recorded
   * verdict and increments nothing — a retry stamps a count the page shows and
   * the classifier reads, so a dropped reply must not become a second go.
   */
  clientRetryId: z.uuid().optional(),
});

/**
 * Another go at the same question.
 *
 * Marked by the same function that marked it the first time, against the same
 * frozen version. A correct retry moves the row to RETRIED and not to RESOLVED,
 * and the response says why: re-answering a question whose answer you have seen
 * mostly measures memory. Resolution needs a different question on the same
 * concept, and that happens on its own the next time one is marked.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const { id } = await params;
  const result = await retryMistake(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    id,
    parsed.data.response,
    parsed.data.clientRetryId ?? null,
  );
  if (!result.ok) return fail("NOT_FOUND", result.message);

  return ok(result);
}
