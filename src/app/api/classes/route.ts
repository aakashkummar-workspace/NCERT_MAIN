import { z } from "zod";
import {
  ClassLimitReached,
  createClass,
  InvalidCurriculumSelection,
  listClasses,
} from "@/core/classes";
import { classLimitMessage, classSeats } from "@/core/classes/limits";
import { guard } from "../_lib/guard";
import { fail, failValidation, ok } from "../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the class a name, like “Class 10-A”.")
    .max(80),
  gradeId: z.uuid(),
  subjectId: z.uuid(),
  academicYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Academic year should look like 2026-27."),
});

export async function GET() {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const classes = await listClasses(check.session.actor.organizationId);
  return ok({ classes });
}

export async function POST(request: Request) {
  // Creating a class is a teaching action, so TEACHER is enough — but the
  // matrix, not this route, is what decides that.
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("VALIDATION_FAILED", "We could not read that request.");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  // The plan says how many classes; the rows say how many there are. Refused
  // here rather than discovered as a class nobody could fill.
  // Checked inside createClass after the curriculum, so a bad request is told
  // what is wrong with it before it is told about the plan.
  const seats = await classSeats(check.session.actor.organizationId);

  try {
    const created = await createClass(check.session.actor, parsed.data, seats);
    return ok(created);
  } catch (error) {
    if (error instanceof ClassLimitReached) {
      return fail("CONFLICT", classLimitMessage(seats), { planLimit: "max_classes" });
    }
    if (error instanceof InvalidCurriculumSelection) {
      return fail("VALIDATION_FAILED", error.message);
    }
    throw error;
  }
}
