import { z } from "zod";
import { MAX_NAME, MAX_NOTE, renameSeries, withdrawSeries } from "@/core/series";
import { guard, notFound } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  name: z.string().trim().min(1).max(MAX_NAME).optional(),
  note: z.string().trim().max(MAX_NOTE).nullable().optional(),
});

async function staff(): Promise<
  { ok: true; actor: { organizationId: string; userId: string; role: string } } | { ok: false; response: Response }
> {
  const check = await guard("organization:read");
  if (!check.ok) return { ok: false, response: check.response };
  if (
    check.session.actor.role === "STUDENT" ||
    check.session.actor.role === "PARENT"
  ) {
    return { ok: false, response: fail("NOT_FOUND", "We could not find that.") };
  }
  return {
    ok: true,
    actor: {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
  };
}

/** Rename one, or change its note. A rename never rewrites a stamped report. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await staff();
  if (!check.ok) return check.response;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("series");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await renameSeries(check.actor, id, parsed.data);
  if (!result.ok) return notFound("series");
  return ok({ renamed: true });
}

/**
 * Withdraw one.
 *
 * The papers are LEFT ALONE — same windows, same students, same marks. The
 * response says how many stopped being grouped, because "where did the
 * half-yearly go" is the support question and the answer is that the label
 * went and six exams did not.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await staff();
  if (!check.ok) return check.response;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("series");

  const result = await withdrawSeries(check.actor, id);
  if (!result.ok) return notFound("series");
  return ok({ withdrawn: true, papers: result.papers });
}
