import { z } from "zod";
import { deleteTopic, renameTopic } from "@/core/curriculum/admin";
import { guardPlatform } from "../../../../_lib/platform";
import { fail, failValidation, ok } from "../../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  title: z.string().trim().min(2).max(160),
});

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

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const actor = {
    userId: check.session.actor.userId,
    organizationId: check.session.actor.organizationId,
  };
  const renamed = await renameTopic(actor, id, parsed.data.title);
  if (!renamed) return fail("NOT_FOUND", "We could not find that topic.");

  return ok({ renamed: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardPlatform();
  if (!check.ok) return check.response;

  const { id } = await params;
  const result = await deleteTopic(
    {
      userId: check.session.actor.userId,
      organizationId: check.session.actor.organizationId,
    },
    id,
  );
  if (!result.deleted) return fail("NOT_FOUND", "We could not find that topic.");

  return ok(result);
}
