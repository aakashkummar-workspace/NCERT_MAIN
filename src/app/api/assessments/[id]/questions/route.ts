import { z } from "zod";
import { setQuestions } from "@/core/assessments";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ questionIds: z.array(z.uuid()).max(100) });

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
    parsed.data.questionIds,
  );
  if (!result.ok && result.error === "NOT_FOUND") return notFound("assessment");
  if (!result.ok) return fail("CONFLICT", result.error);
  return ok({ count: result.count });
}
