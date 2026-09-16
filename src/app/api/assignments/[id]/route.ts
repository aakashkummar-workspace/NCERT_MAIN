import { z } from "zod";
import {
  cancelAssignment,
  getAssignment,
  updateAssignment,
} from "@/core/assignments";
import { guard, notFound } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const PatchBody = z.object({
  opensAt: z.iso.datetime().optional(),
  closesAt: z.iso.datetime().optional(),
  durationOverrideMinutes: z.number().int().min(5).max(360).nullable().optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  resultsPolicy: z.enum(["IMMEDIATE", "AFTER_CLOSE", "MANUAL"]).optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  // Malformed is missing: a 404, never a database error surfacing as a 500.
  if (!z.uuid().safeParse(id).success) return fail("NOT_FOUND", "We could not find that.");
  const assignment = await getAssignment(
    check.session.actor.organizationId,
    id,
  );
  if (!assignment) return notFound("assignment");

  return ok(assignment);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  // Malformed is missing: a 404, never a database error surfacing as a 500.
  if (!z.uuid().safeParse(id).success) return fail("NOT_FOUND", "We could not find that.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  // Build the patch explicitly rather than spreading: the parsed dates are
  // strings, and spreading them over the Date fields is how a string reaches
  // code that expects an instant.
  const { opensAt, closesAt, ...rest } = parsed.data;
  const result = await updateAssignment(check.session.actor, id, {
    ...rest,
    ...(opensAt ? { opensAt: new Date(opensAt) } : {}),
    ...(closesAt ? { closesAt: new Date(closesAt) } : {}),
  });

  if (!result.ok && result.message === "NOT_FOUND") return notFound("assignment");
  if (!result.ok) return fail("VALIDATION_FAILED", result.message);
  return ok({ saved: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  // Malformed is missing: a 404, never a database error surfacing as a 500.
  if (!z.uuid().safeParse(id).success) return fail("NOT_FOUND", "We could not find that.");
  const cancelled = await cancelAssignment(check.session.actor, id);
  if (!cancelled) return notFound("assignment");

  return ok({ cancelled: true });
}
