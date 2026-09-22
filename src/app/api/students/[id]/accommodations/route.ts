import { z } from "zod";
import { EXTRA_TIME_OPTIONS, setAccommodations } from "@/core/roster/accommodations";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  extraTimePercent: z.number().int().refine((value) => (EXTRA_TIME_OPTIONS as readonly number[]).includes(value), {
    message: "Extra time is 0, 25, 33 or 50 per cent.",
  }),
  readAloud: z.boolean(),
});

/** Set one student's exam accommodations. Staff only. */
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

  const result = await setAccommodations(check.session.actor, id, parsed.data);
  if (!result.ok) return fail("NOT_FOUND", result.message);
  return ok(parsed.data);
}
