import { z } from "zod";
import { getClass } from "@/core/classes";
import { studentLimitReason, studentSeats } from "@/core/classes/limits";
import { parseRoster } from "@/core/roster/parse";
import { addStudents, removeStudent } from "@/core/roster/add";
import { guard, notFound } from "../../../_lib/guard";
import { fail, failValidation, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

const AddBody = z.object({ text: z.string().max(200_000) });
const RemoveBody = z.object({ studentUserId: z.uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const { organizationId } = check.session.actor;

  const target = await getClass(organizationId, id);
  if (!target) return notFound("class");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = AddBody.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const roster = parseRoster(parsed.data.text);
  if (roster.students.length === 0) {
    return fail(
      "VALIDATION_FAILED",
      "We could not find any student names in that. Put one name on each line.",
      { problems: roster.problems },
    );
  }

  const seats = await studentSeats(organizationId);
  const result = await addStudents(check.session.actor, id, roster.students, {
    remaining: seats.remaining,
    reason: studentLimitReason(seats),
  });
  return ok({ ...result, problems: roster.problems });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = RemoveBody.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const removed = await removeStudent(
    check.session.actor,
    id,
    parsed.data.studentUserId,
  );
  if (!removed) return notFound("student in this class");

  return ok({ removed: true });
}
