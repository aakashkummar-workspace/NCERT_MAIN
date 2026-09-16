import { z } from "zod";
import { createConcept } from "@/core/curriculum/concept-admin";
import { guardPlatform } from "../../../_lib/platform";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Creating a concept.
 *
 * Platform only, on the platform connection, and audited — a concept has no
 * `organization_id`, so writing one changes what every customer measures at
 * once. There is deliberately no DELETE here or on the detail route: nothing
 * has a foreign key from evidence to concepts, so a delete would succeed and
 * silently orphan every mastery estimate derived through it.
 */
const Body = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().max(500).optional(),
});

export async function POST(request: Request) {
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

  const created = await createConcept(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    parsed.data,
  );
  if (!created.ok) {
    return fail("VALIDATION_FAILED", created.problems[0]!.message, {
      problems: created.problems,
    });
  }
  return ok({ id: created.id }, { status: 201 });
}
