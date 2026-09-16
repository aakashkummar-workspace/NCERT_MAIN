import { z } from "zod";
import { setContributing } from "@/core/benchmarks";
import { guard } from "../../_lib/guard";
import { failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ contributing: z.boolean() });

/**
 * Agree to contribute this school's figures to the cross-school benchmarks,
 * or withdraw.
 *
 * `organization:update`, because it is a decision about the school rather than
 * about a class — an owner or an admin, not every teacher.
 *
 * It is deliberately NOT gated on a plan. Reading a benchmark is not gated
 * either: contributing is not the price of reading, and reading is not the
 * price of contributing. A gate on this switch would make participation
 * something a school buys rather than something it agrees to.
 *
 * Withdrawing deletes what this school contributed, and the response says how
 * many concepts went — "did our figures actually come out" is the question
 * somebody asks straight afterwards.
 */
export async function PUT(request: Request) {
  const check = await guard("organization:update");
  if (!check.ok) return check.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await setContributing(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    parsed.data.contributing,
  );
  return ok(result);
}
