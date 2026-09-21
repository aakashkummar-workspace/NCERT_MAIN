import { z } from "zod";
import { setQuestions } from "@/core/assessments";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Either the plain list of ids, or the layout: each question with its section
 * and, for an internal choice, the group it shares with its alternative.
 */
const Body = z.union([
  z.object({ questionIds: z.array(z.uuid()).max(100) }),
  z.object({
    items: z
      .array(
        z.object({
          questionId: z.uuid(),
          section: z.string().max(4).nullable().optional(),
          choiceGroup: z.number().int().min(1).max(1000).nullable().optional(),
        }),
      )
      .max(100),
  }),
]);

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await setQuestions(
    check.session.actor,
    id,
    "items" in parsed.data ? parsed.data.items : parsed.data.questionIds,
  );
  if (!result.ok && result.error === "NOT_FOUND") return notFound("assessment");
  if (!result.ok) return fail("CONFLICT", result.error);
  return ok({ count: result.count });
}
