import { z } from "zod";
import { setApaar } from "@/core/roster/apaar";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ apaarId: z.string().max(40).nullable() });

/** Set or clear one student's APAAR ID. Staff only. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("student");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await setApaar(check.session.actor, id, parsed.data.apaarId);
  if (!result.ok) {
    return fail(
      result.code === "TAKEN" ? "CONFLICT" : result.code === "INVALID" ? "VALIDATION_FAILED" : "NOT_FOUND",
      result.message,
    );
  }
  return ok({ apaarId: result.apaarId });
}
