import { z } from "zod";
import {
  closeAssessment,
  duplicateAssessment,
  getAssessment,
  publishCheck,
  updateDraft,
} from "@/core/assessments";
import {
  BASICS_MESSAGE,
  DURATION_MAX,
  DURATION_MIN,
  MARKS_MAX,
  MARKS_MIN,
} from "@/core/assessments/basics";
import { guard, notFound } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

export const BlueprintSchema = z.object({
  totalQuestions: z.number().int().min(1).max(100),
  totalMarks: z.number().int().min(1).max(200),
  difficultyMix: z.object({
    EASY: z.number().min(0).max(100),
    MEDIUM: z.number().min(0).max(100),
    HARD: z.number().min(0).max(100),
  }),
  typeMix: z.record(z.string(), z.number().min(0).max(100)),
  outcomeIds: z.array(z.uuid()).max(60),
  pattern: z
    .object({
      key: z.string().max(40),
      label: z.string().max(120),
      sections: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(4),
            title: z.string().max(80),
            types: z
              .array(
                z.enum([
                  "MCQ",
                  "MULTI_SELECT",
                  "TRUE_FALSE",
                  "NUMERIC",
                  "FILL_BLANK",
                  "ASSERTION_REASON",
                  "VSA",
                  "SA",
                  "LA",
                  "CASE_STUDY",
                ]),
              )
              .min(1)
              .max(10),
            count: z.number().int().min(1).max(100),
            marksEach: z.number().int().min(1).max(20),
            internalChoices: z.number().int().min(0).max(100),
          }),
        )
        .min(1)
        .max(10),
    })
    .nullable()
    .optional(),
});

const PatchBody = z.object({
  title: z.string().trim().min(2, BASICS_MESSAGE.title).max(120).optional(),
  durationMinutes: z
    .number(BASICS_MESSAGE.durationMinutes)
    .int(BASICS_MESSAGE.durationMinutes)
    .min(DURATION_MIN, BASICS_MESSAGE.durationMinutes)
    .max(DURATION_MAX, BASICS_MESSAGE.durationMinutes)
    .optional(),
  totalMarks: z
    .number(BASICS_MESSAGE.totalMarks)
    .int(BASICS_MESSAGE.totalMarks)
    .min(MARKS_MIN, BASICS_MESSAGE.totalMarks)
    .max(MARKS_MAX, BASICS_MESSAGE.totalMarks)
    .optional(),
  classId: z.uuid().nullable().optional(),
  blueprint: BlueprintSchema.optional(),
  settings: z
    .object({
      shuffleQuestions: z.boolean(),
      shuffleOptions: z.boolean(),
      allowReview: z.boolean(),
    })
    .optional(),
});

const ActionBody = z.object({ action: z.enum(["duplicate", "close"]) });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const [assessment, readiness] = await Promise.all([
    getAssessment(check.session.actor.organizationId, id),
    publishCheck(check.session.actor.organizationId, id),
  ]);
  if (!assessment) return notFound("assessment");

  return ok({ ...assessment, readiness });
}

export async function PATCH(
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

  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await updateDraft(
    check.session.actor,
    id,
    parsed.data as Parameters<typeof updateDraft>[2],
  );
  if (!result.ok && result.error === "NOT_FOUND") return notFound("assessment");
  if (!result.ok) return fail("CONFLICT", result.error);
  return ok({ saved: true });
}

export async function POST(
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

  const parsed = ActionBody.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  if (parsed.data.action === "duplicate") {
    const copy = await duplicateAssessment(check.session.actor, id);
    if (!copy) return notFound("assessment");
    return ok(copy);
  }

  const closed = await closeAssessment(check.session.actor, id);
  if (!closed) return notFound("published assessment");
  return ok({ closed: true });
}
