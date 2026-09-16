import { z } from "zod";
import { planIntervention } from "@/core/gaps/interventions";
import { guard } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  kind: z.enum(["REMEDIAL_ASSESSMENT", "PRACTICE_SET", "LESSON_PLAN", "MANUAL"]),
  note: z.string().max(1000).optional(),
});

/**
 * Record that something is being done about a gap.
 *
 * This is the plain version — a lesson, a worksheet, a conversation. It exists
 * so that what a teacher actually did off-platform still gets a baseline
 * stamped against it, and can be measured afterwards like anything else. A
 * product that could only measure the interventions it generated itself would
 * be measuring itself.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const { id } = await params;
  // Malformed is missing: a 404, never a database error surfacing as a 500.
  if (!z.uuid().safeParse(id).success) return fail("NOT_FOUND", "We could not find that.");
  const result = await planIntervention(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
    parsed.data,
  );
  // A gap that is not this tenant's answers 404, indistinguishable from one
  // that never existed. A 409 would confirm the row is there.
  if (!result.ok) return fail(result.reason, result.message);

  return ok(result, { status: 201 });
}
