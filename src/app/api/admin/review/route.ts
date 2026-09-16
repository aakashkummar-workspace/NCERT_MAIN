import { z } from "zod";
import { approveConcept, approveOutcome, confirmTag } from "@/core/curriculum/review";
import { guardPlatform } from "../../_lib/platform";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve-outcome"), id: z.uuid() }),
  z.object({ action: z.literal("approve-concept"), id: z.uuid() }),
  z.object({ action: z.literal("confirm-tag"), id: z.uuid(), outcomeId: z.uuid() }),
]);

/** One review decision at a time — there is deliberately no bulk approve. */
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

  const actor = {
    userId: check.session.actor.userId,
    organizationId: check.session.actor.organizationId,
  };
  const body = parsed.data;

  if (body.action === "approve-outcome") {
    return (await approveOutcome(actor, body.id))
      ? ok({ reviewed: true })
      : fail("NOT_FOUND", "We could not find that outcome.");
  }
  if (body.action === "approve-concept") {
    return (await approveConcept(actor, body.id))
      ? ok({ reviewed: true })
      : fail("NOT_FOUND", "We could not find that concept.");
  }
  const result = await confirmTag(actor, body.id, body.outcomeId);
  return result.ok
    ? ok({ reviewed: true, changed: result.changed })
    : fail("VALIDATION_FAILED", result.message);
}
