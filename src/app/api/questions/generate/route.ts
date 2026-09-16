import { z } from "zod";
import { generateIntoBank } from "@/core/questions/generate";
import { guard } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";
// Generation takes tens of seconds. The route streams nothing and simply waits;
// the client shows a pending state and the gateway's own timeout is the bound.
export const maxDuration = 300;

const Body = z.object({
  chapterId: z.uuid(),
  count: z.number().int().min(1).max(10),
  types: z
    .array(z.enum(["MCQ", "TRUE_FALSE", "NUMERIC", "VSA", "SA"]))
    .min(1)
    .max(3),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
  marks: z.number().int().min(1).max(6),
});

/**
 * Generate questions into the bank, as DRAFTs.
 *
 * Nothing here can produce an approved question. The drafts land in the same
 * bank a teacher types into, behind the same validator and the same duplicate
 * check, and a person still has to approve each one.
 */
export async function POST(request: Request) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await generateIntoBank(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    parsed.data,
  );

  if (!result.ok) {
    // A budget refusal and a model refusal are different things to a teacher,
    // and the code says which.
    return fail(
      result.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_FAILED",
      result.message,
    );
  }

  return ok(result);
}
