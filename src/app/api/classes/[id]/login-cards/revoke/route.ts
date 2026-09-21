import { z } from "zod";
import { revokeCard } from "@/core/identity/login-cards";
import { guard, notFound } from "../../../../_lib/guard";
import { fail, failValidation, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ studentUserId: z.uuid() });

/** Stop one student's card working — for a card reported lost. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  const role = check.session.actor.role;
  if (role === "STUDENT" || role === "PARENT") return notFound("class");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("class");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const revoked = await revokeCard(check.session.actor, id, parsed.data.studentUserId);
  if (!revoked) return notFound("card");
  return ok({ revoked: true });
}
