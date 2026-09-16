import { deleteOutcome, updateOutcome } from "@/core/curriculum/admin";
import { checkOutcomeStatement } from "@/core/curriculum/outcome-quality";
import { guardPlatform } from "../../../../_lib/platform";
import { fail, failValidation, ok } from "../../../../_lib/respond";
import { OutcomeBody } from "../route";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardPlatform();
  if (!check.ok) return check.response;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = OutcomeBody.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const updated = await updateOutcome(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    id,
    parsed.data,
  );
  if (!updated) return fail("NOT_FOUND", "We could not find that outcome.");

  return ok({
    updated: true,
    quality: checkOutcomeStatement(parsed.data.statement),
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardPlatform();
  if (!check.ok) return check.response;

  const { id } = await params;
  const deleted = await deleteOutcome(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    id,
  );
  if (!deleted) return fail("NOT_FOUND", "We could not find that outcome.");

  return ok({ deleted: true });
}
