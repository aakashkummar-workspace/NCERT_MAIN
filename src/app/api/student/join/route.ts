import { z } from "zod";
import { joinClassByCode } from "@/core/roster/join";
import { guardStudent } from "../../_lib/student";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ code: z.string().min(1).max(20) });

/**
 * Join a class with the code the teacher read out.
 *
 * The only route in the product where a student adds themselves to something.
 * It is scoped to their own organization — see the note in core/roster/join.
 */
export async function POST(request: Request) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await joinClassByCode(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    parsed.data.code,
  );
  if (!result.ok) return fail("NOT_FOUND", result.message);

  return ok(result);
}
