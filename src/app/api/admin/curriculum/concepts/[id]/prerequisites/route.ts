import { z } from "zod";
import {
  addPrerequisite,
  removePrerequisite,
} from "@/core/curriculum/concept-admin";
import { guardPlatform } from "../../../../../_lib/platform";
import { fail, failValidation, ok } from "../../../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  prerequisiteId: z.uuid(),
  strength: z.number().min(0).max(1).optional(),
});

/**
 * Declare that this concept rests on another.
 *
 * Refused when it would close a loop. `prerequisitesOf` is walked to name a
 * root cause — "they are stuck on similarity because they are weak on ratio" —
 * and in a cycle every concept is the root cause of itself.
 */
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
  const added = await addPrerequisite(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    id,
    parsed.data.prerequisiteId,
    parsed.data.strength ?? 1,
  );
  if (!added.ok) {
    return fail("VALIDATION_FAILED", added.problems[0]!.message, {
      problems: added.problems,
    });
  }
  return ok({ id });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardPlatform();
  if (!check.ok) return check.response;

  const prerequisiteId = new URL(request.url).searchParams.get("prerequisiteId");
  if (!prerequisiteId) {
    return fail("VALIDATION_FAILED", "Name the prerequisite to remove.");
  }

  const { id } = await params;
  const removed = await removePrerequisite(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    id,
    prerequisiteId,
  );
  if (!removed) return fail("NOT_FOUND", "That prerequisite is not set.");
  return ok({ id });
}
