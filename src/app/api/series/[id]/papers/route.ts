import { z } from "zod";
import { addPaper, removePaper } from "@/core/series";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({ assignmentId: z.uuid() });

async function staff() {
  const check = await guard("organization:read");
  if (!check.ok) return { ok: false as const, response: check.response };
  if (
    check.session.actor.role === "STUDENT" ||
    check.session.actor.role === "PARENT"
  ) {
    return {
      ok: false as const,
      response: fail("NOT_FOUND", "We could not find that."),
    };
  }
  return {
    ok: true as const,
    actor: {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
  };
}

/** Put a paper in this series. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await staff();
  if (!check.ok) return check.response;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("series");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await addPaper(check.actor, id, parsed.data.assignmentId);
  if (!result.ok) {
    // A paper already in another series is a fact to state, not a validation
    // error — and never a silent move.
    return result.reason === "taken"
      ? fail("CONFLICT", result.message)
      : notFound("paper");
  }
  return ok({ added: true }, { status: 201 });
}

/** Take a paper out. The paper itself is untouched. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await staff();
  if (!check.ok) return check.response;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("series");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await removePaper(check.actor, id, parsed.data.assignmentId);
  if (!result.ok) return notFound("paper");
  return ok({ removed: true });
}
