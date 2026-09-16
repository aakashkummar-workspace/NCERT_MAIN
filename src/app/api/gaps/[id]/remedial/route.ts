import { z } from "zod";
import { buildRemedial, planRemedial } from "@/core/gaps/remedial";
import { guard } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  opensAt: z.coerce.date(),
  closesAt: z.coerce.date(),
});

/**
 * What the button would do, before it does it.
 *
 * Same code path as the POST, so the preview cannot disagree with the outcome —
 * the rule the roster importer established and everything since has kept.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  // Malformed is missing: a 404, never a database error surfacing as a 500.
  if (!z.uuid().safeParse(id).success) return fail("NOT_FOUND", "We could not find that.");
  const plan = await planRemedial(check.session.actor.organizationId, id);
  if ("error" in plan) return fail("NOT_FOUND", plan.error);

  return ok(plan);
}

/**
 * Build the paper, publish it, assign it to the students who need it, and
 * stamp the baseline — in that order, in one call.
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
  const result = await buildRemedial(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    id,
    parsed.data,
  );
  if (!result.ok) return fail(result.reason, result.message);

  return ok(result, { status: 201 });
}
