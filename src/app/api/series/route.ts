import { z } from "zod";
import { createSeries, listSeries, MAX_NAME, MAX_NOTE } from "@/core/series";
import { guard } from "../_lib/guard";
import { fail, failValidation, ok } from "../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  name: z.string().trim().min(1).max(MAX_NAME),
  // "2026-27". Sent rather than inferred, because a school setting up next
  // year's pre-boards in March means next year.
  academicYear: z.string().regex(/^\d{4}-\d{2}$/),
  note: z.string().trim().max(MAX_NOTE).optional(),
});

export async function GET(request: Request) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  if (
    check.session.actor.role === "STUDENT" ||
    check.session.actor.role === "PARENT"
  ) {
    return fail("NOT_FOUND", "We could not find that.");
  }

  const url = new URL(request.url);
  const academicYear = url.searchParams.get("academicYear") ?? undefined;
  if (academicYear !== undefined && !/^\d{4}-\d{2}$/.test(academicYear)) {
    return fail("VALIDATION_FAILED", "An academic year looks like 2026-27.");
  }

  return ok({
    series: await listSeries(check.session.actor.organizationId, { academicYear }),
  });
}

/**
 * Name a series.
 *
 * It holds no papers yet and no window: a series is a label, and the papers
 * join it afterwards — including papers already sat, because a school
 * routinely names the event after the week it happened in.
 */
export async function POST(request: Request) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  if (
    check.session.actor.role === "STUDENT" ||
    check.session.actor.role === "PARENT"
  ) {
    return fail("NOT_FOUND", "We could not find that.");
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await createSeries(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    parsed.data,
  );
  if (!result.ok) {
    // A duplicate name is the state of the world, not a malformed request.
    return fail(
      result.reason === "duplicate" ? "CONFLICT" : "VALIDATION_FAILED",
      result.message,
    );
  }
  return ok(result, { status: 201 });
}
