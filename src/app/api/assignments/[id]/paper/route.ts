import { z } from "zod";
import { paperSheet, recordPaperSitting } from "@/core/paper";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * A paper sat on paper: the sheet to record against, and recording one
 * student's sitting. See core/paper.
 */

function staff(role: string) {
  return role !== "STUDENT" && role !== "PARENT";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  if (!staff(check.session.actor.role)) return notFound("paper");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("paper");

  const sheet = await paperSheet(check.session.actor.organizationId, id);
  if (!sheet) return notFound("paper");
  return ok(sheet, { headers: { "Cache-Control": "no-store" } });
}

const Entry = z.discriminatedUnion("kind", [
  z.object({ assessmentQuestionId: z.uuid(), kind: z.literal("choice"), keys: z.array(z.string().max(4)).max(8) }),
  z.object({ assessmentQuestionId: z.uuid(), kind: z.literal("boolean"), value: z.boolean() }),
  z.object({ assessmentQuestionId: z.uuid(), kind: z.literal("numeric"), value: z.number() }),
  z.object({ assessmentQuestionId: z.uuid(), kind: z.literal("text"), value: z.string().max(500) }),
  z.object({ assessmentQuestionId: z.uuid(), kind: z.literal("written"), marks: z.number().nullable() }),
  z.object({ assessmentQuestionId: z.uuid(), kind: z.literal("blank") }),
]);

const Body = z.object({
  studentUserId: z.uuid(),
  entries: z.array(Entry).max(200),
  /** The day the paper was sat, when it was not the day the window opened. */
  satOn: z.iso.datetime().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  if (!staff(check.session.actor.role)) return notFound("paper");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("paper");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const satOn = parsed.data.satOn ? new Date(parsed.data.satOn) : undefined;
  if (satOn && satOn.getTime() > Date.now() + 60_000) {
    return fail("VALIDATION_FAILED", "A paper cannot have been sat in the future.");
  }

  const result = await recordPaperSitting(
    check.session.actor,
    id,
    parsed.data.studentUserId,
    parsed.data.entries,
    satOn,
  );
  if (!result.ok) {
    if (result.code === "NOT_FOUND") return notFound("paper");
    if (result.code === "CONFLICT") return fail("CONFLICT", result.message);
    return fail("VALIDATION_FAILED", result.message);
  }
  return ok(result);
}
