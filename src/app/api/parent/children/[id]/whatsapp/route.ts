import { z } from "zod";
import { setDigest } from "@/core/digest";
import { guardParent } from "../../../../_lib/parent";
import { fail, failValidation, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ on: z.boolean() });

/** The parent turns their weekly WhatsApp summary about one child on or off. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const check = await guardParent();
  if (!check.ok) return check.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("NOT_FOUND", "We could not find that.");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const done = await setDigest(
    { organizationId: check.session.actor.organizationId, userId: check.session.actor.userId },
    id,
    parsed.data.on,
  );
  if (!done) return fail("NOT_FOUND", "We could not find that.");
  return ok({ on: parsed.data.on });
}
