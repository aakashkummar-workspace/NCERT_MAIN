import { z } from "zod";
import { cardStatusForClass, issueCards } from "@/core/identity/login-cards";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

function staffOnly(role: string) {
  return role !== "STUDENT" && role !== "PARENT";
}

/** Which students hold a working card. Never a code — those are not stored. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  if (!staffOnly(check.session.actor.role)) return notFound("class");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("class");

  const status = await cardStatusForClass(check.session.actor.organizationId, id);
  if (!status) return notFound("class");
  return ok({ students: status });
}

const Body = z.object({
  scope: z.enum(["missing", "all"]),
  studentIds: z.array(z.uuid()).max(500).optional(),
});

/**
 * Issue cards. The response is the ONLY time the codes exist anywhere but on
 * paper, so it is never cached.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  if (!staffOnly(check.session.actor.role)) return notFound("class");

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

  const result = await issueCards(check.session.actor, id, parsed.data);
  if (!result.ok) {
    if (result.code === "NOT_FOUND") return notFound("class");
    return fail("CONFLICT", result.message);
  }
  return ok(
    { className: result.className, cards: result.cards },
    { headers: { "Cache-Control": "no-store" } },
  );
}
