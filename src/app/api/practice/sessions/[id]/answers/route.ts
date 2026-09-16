import { z } from "zod";
import { answerPractice } from "@/core/practice";
import { guardStudent } from "../../../../_lib/student";
import { fail, failValidation, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  practiceAnswerId: z.string().uuid(),
  response: z.union([
    z.object({ kind: z.literal("choice"), keys: z.array(z.string()).max(8) }),
    z.object({ kind: z.literal("boolean"), value: z.boolean() }),
    z.object({ kind: z.literal("numeric"), value: z.number() }),
    z.object({ kind: z.literal("text"), value: z.string().max(2000) }),
  ]),
  timeSpentSeconds: z.number().int().min(0).max(3600).optional(),
});

/**
 * Answer one question, and be told at once.
 *
 * The verdict, the correct answer and the explanation all come back in this
 * response — that immediacy is the whole difference between practice and a
 * test. Answering the same question twice is refused: a set a student could
 * walk until every verdict was green would make practice evidence worthless.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  // The session id in the path is not trusted to scope anything — the answer
  // row is looked up by its own id and checked against the session's owner.
  await params;

  const result = await answerPractice(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    parsed.data.practiceAnswerId,
    parsed.data.response,
    parsed.data.timeSpentSeconds ?? 0,
  );
  if (!result.ok) return fail("CONFLICT", result.message);

  return ok(result);
}
