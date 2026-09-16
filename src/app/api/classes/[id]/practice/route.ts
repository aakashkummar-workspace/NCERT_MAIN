import { z } from "zod";
import { assignPractice, cancelAssignedPractice } from "@/core/practice/assigned";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  conceptId: z.uuid(),
  questionCount: z.number().int().min(1).max(20),
  // A date, not a datetime: a teacher says "by Friday", not "by 16:00 on
  // Friday", and a time nobody chose would be a deadline nobody agreed to.
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(200).optional(),
});

const CancelBody = z.object({ assignedPracticeId: z.uuid() });

/**
 * Set practice for a class: one idea, a count, and a date.
 *
 * The class comes from the path and the organization from the session, as
 * everywhere. `assignPractice` refuses when the bank cannot honour the count,
 * so nobody puts a card on thirty home pages that cannot be done.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  if (check.session.actor.role === "STUDENT" || check.session.actor.role === "PARENT") {
    return fail("NOT_FOUND", "We could not find that.");
  }

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("class");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await assignPractice(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    {
      classId: id,
      conceptId: parsed.data.conceptId,
      questionCount: parsed.data.questionCount,
      // End of the day in IST: "by Friday" means Friday, not Friday morning.
      dueAt: parsed.data.dueOn
        ? new Date(`${parsed.data.dueOn}T23:59:59+05:30`)
        : null,
      note: parsed.data.note ?? null,
    },
  );

  if (!result.ok) {
    if (result.reason === "not-found") return notFound("class");
    // A thin bank is the state of the world, not a malformed request, and the
    // message names the number so a teacher can decide what to do about it.
    return fail("CONFLICT", result.message);
  }

  return ok(result, { status: 201 });
}

/** Withdraw one. A stamp, never a delete — sittings already point at it. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  if (check.session.actor.role === "STUDENT" || check.session.actor.role === "PARENT") {
    return fail("NOT_FOUND", "We could not find that.");
  }

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("class");

  const parsed = CancelBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const result = await cancelAssignedPractice(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
      role: check.session.actor.role,
    },
    parsed.data.assignedPracticeId,
  );
  if (!result.ok) return notFound("practice set");

  return ok({ cancelled: true });
}
