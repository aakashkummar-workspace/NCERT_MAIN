import { z } from "zod";
import { addOutcome } from "@/core/curriculum/admin";
import { checkOutcomeStatement } from "@/core/curriculum/outcome-quality";
import { guardPlatform } from "../../../_lib/platform";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

export const OutcomeBody = z.object({
  code: z.string().trim().min(1, "Give the outcome a short code.").max(24),
  statement: z.string().trim().min(1, "Write the statement.").max(400),
  bloomLevel: z.enum([
    "REMEMBER",
    "UNDERSTAND",
    "APPLY",
    "ANALYSE",
    "EVALUATE",
    "CREATE",
  ]),
  competency: z.enum([
    "KNOWLEDGE",
    "UNDERSTANDING",
    "APPLICATION",
    "PROBLEM_SOLVING",
    "ANALYSIS",
    "EVALUATION",
  ]),
  typicalMarks: z.number().int().min(1).max(10),
});

const Body = OutcomeBody.extend({ topicId: z.uuid() });

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

  const { topicId, ...outcome } = parsed.data;
  const created = await addOutcome(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    topicId,
    outcome,
  );

  if (created === null) return fail("NOT_FOUND", "We could not find that topic.");
  if ("conflict" in created) {
    return fail(
      "CONFLICT",
      `An outcome called ${outcome.code} already exists in this topic. Codes are how questions point at outcomes, so they have to be unique.`,
    );
  }

  // The statement quality verdict rides back with the created row. It never
  // blocks the write — an author may know better than a heuristic — but it is
  // shown immediately, while fixing it is still cheap.
  return ok({ ...created, quality: checkOutcomeStatement(outcome.statement) });
}
