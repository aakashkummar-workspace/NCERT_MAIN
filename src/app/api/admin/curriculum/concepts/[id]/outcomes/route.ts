import { z } from "zod";
import { linkOutcome, unlinkOutcome } from "@/core/curriculum/concept-admin";
import { guardPlatform } from "../../../../../_lib/platform";
import { fail, failValidation, ok } from "../../../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  outcomeId: z.uuid(),
  weight: z.number().min(0).max(1).optional(),
});

/** Link an outcome, or change the weight of a link that already exists. */
export async function POST(
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
  const linked = await linkOutcome(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    id,
    parsed.data.outcomeId,
    parsed.data.weight ?? 1,
  );
  if (!linked.ok) {
    return fail("VALIDATION_FAILED", linked.problems[0]!.message, {
      problems: linked.problems,
    });
  }
  return ok({ id });
}

/**
 * Stop measuring this concept through this outcome.
 *
 * Not a delete of anything a student did: `concept_evidence` carries its own
 * `concept_id`, so everything already measured keeps its meaning and every past
 * estimate stays re-derivable. Only future answers change.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardPlatform();
  if (!check.ok) return check.response;

  const outcomeId = new URL(request.url).searchParams.get("outcomeId");
  if (!outcomeId) return fail("VALIDATION_FAILED", "Name the outcome to unlink.");

  const { id } = await params;
  const removed = await unlinkOutcome(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    id,
    outcomeId,
  );
  if (!removed) return fail("NOT_FOUND", "That outcome is not linked.");
  return ok({ id });
}
