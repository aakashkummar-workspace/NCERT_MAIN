import { z } from "zod";
import { draftConcepts } from "@/core/curriculum/concept-suggest";
import { createConceptWithOutcomes, linkUncoveredOutcomes } from "@/core/curriculum/concept-admin";
import { guardPlatform } from "../../../../_lib/platform";
import { fail, failValidation, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Drafting concepts for a subject, and accepting one.
 *
 * Two actions on one route because they are two halves of one review: propose,
 * then approve. Nothing is written by the proposal — `accept` is a separate
 * request a person makes, which is the whole point.
 */
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft"), subjectId: z.uuid() }),
  z.object({
    action: z.literal("accept"),
    name: z.string().trim().min(1),
    description: z.string().trim().max(500).optional(),
    outcomeIds: z.array(z.uuid()).min(1).max(12),
  }),
  // Accepting a suggested link to a concept that already exists. The concept
  // and outcomes are ids from the draft, so they are re-checked, not trusted.
  z.object({
    action: z.literal("link"),
    conceptId: z.uuid(),
    outcomeIds: z.array(z.uuid()).min(1).max(12),
  }),
]);

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

  if (parsed.data.action === "draft") {
    const result = await draftConcepts(actor, {
      subjectId: parsed.data.subjectId,
    });
    if (!result.ok) return fail("CONFLICT", result.message);
    return ok(result);
  }

  if (parsed.data.action === "link") {
    const linked = await linkUncoveredOutcomes(actor, parsed.data.conceptId, parsed.data.outcomeIds);
    if (!linked.ok) {
      return fail("VALIDATION_FAILED", linked.problems[0]!.message, { problems: linked.problems });
    }
    return ok(linked);
  }

  const created = await createConceptWithOutcomes(actor, {
    name: parsed.data.name,
    description: parsed.data.description,
    outcomeIds: parsed.data.outcomeIds,
  });
  if (!created.ok) {
    return fail("VALIDATION_FAILED", created.problems[0]!.message, {
      problems: created.problems,
    });
  }
  return ok(created, { status: 201 });
}
