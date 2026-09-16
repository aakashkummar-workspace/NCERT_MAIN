import { z } from "zod";
import { createAssessment, listAssessments } from "@/core/assessments";
import {
  BASICS_MESSAGE,
  DURATION_MAX,
  DURATION_MIN,
  MARKS_MAX,
  MARKS_MIN,
} from "@/core/assessments/basics";
import { guard } from "../_lib/guard";
import { fail, failValidation, ok } from "../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  title: z.string().trim().min(2, BASICS_MESSAGE.title).max(120),
  subjectId: z.uuid(),
  gradeId: z.uuid(),
  classId: z.uuid().nullable().optional(),
  durationMinutes: z
    .number(BASICS_MESSAGE.durationMinutes)
    .int(BASICS_MESSAGE.durationMinutes)
    .min(DURATION_MIN, BASICS_MESSAGE.durationMinutes)
    .max(DURATION_MAX, BASICS_MESSAGE.durationMinutes),
  totalMarks: z
    .number(BASICS_MESSAGE.totalMarks)
    .int(BASICS_MESSAGE.totalMarks)
    .min(MARKS_MIN, BASICS_MESSAGE.totalMarks)
    .max(MARKS_MAX, BASICS_MESSAGE.totalMarks),
});

export async function GET() {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  const assessments = await listAssessments(check.session.actor.organizationId);
  return ok({ assessments });
}

export async function POST(request: Request) {
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

  const result = await createAssessment(check.session.actor, parsed.data);
  if ("error" in result) return fail("VALIDATION_FAILED", result.error);
  return ok(result);
}
