import { z } from "zod";
import { renameConcept } from "@/core/curriculum/concept-admin";
import { guardPlatform } from "../../../../_lib/platform";
import { fail, failValidation, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().max(500).optional(),
});

/**
 * Renaming a concept. The slug does not follow — it is an identifier, and one
 * that changes when somebody fixes a typo is one nothing can rely on.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardPlatform();
  if (!check.ok) return check.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { id } = await params;
  const updated = await renameConcept(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    id,
    parsed.data,
  );
  if (!updated.ok) {
    return fail("VALIDATION_FAILED", updated.problems[0]!.message, {
      problems: updated.problems,
    });
  }
  return ok({ id });
}
