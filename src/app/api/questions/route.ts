import { z } from "zod";
import { bankSummary, createQuestion, searchQuestions } from "@/core/questions";
import { guard } from "../_lib/guard";
import { fail, failValidation, ok } from "../_lib/respond";

export const runtime = "nodejs";

const OptionSchema = z.object({
  key: z.string().min(1).max(4),
  text: z.string().max(1000),
  isCorrect: z.boolean(),
});

const AnswerKeySchema = z.union([
  z.object({ kind: z.literal("choice"), correctKeys: z.array(z.string()) }),
  z.object({ kind: z.literal("boolean"), correct: z.boolean() }),
  z.object({
    kind: z.literal("numeric"),
    value: z.number(),
    tolerance: z.number(),
    unit: z.string().optional(),
  }),
  z.object({
    kind: z.literal("text"),
    accepted: z.array(z.string()),
    caseSensitive: z.boolean(),
  }),
  z.null(),
]);

// Shape only. Whether the criteria add up to the question's marks is decided by
// validateRubric in core, the same function the editor runs while typing.
const RubricSchema = z.object({
  criteria: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().max(120),
        marks: z.number(),
        descriptor: z.string().max(1000).nullable().optional(),
      }),
    )
    .max(20),
});

export const QuestionBody = z.object({
  type: z.enum([
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
  subjectId: z.uuid(),
  chapterId: z.uuid().nullable().optional(),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
  marks: z.number().int().min(1).max(20),
  expectedTimeSeconds: z.number().int().min(5).max(3600).nullable().optional(),
  stem: z.string().max(4000),
  options: z.array(OptionSchema).max(8).nullable().optional(),
  answerKey: AnswerKeySchema.optional(),
  explanation: z.string().max(4000).nullable().optional(),
  hint: z.string().max(1000).nullable().optional(),
  // Omitted on an edit means "keep what is there"; null means "remove it".
  rubric: RubricSchema.nullable().optional(),
  outcomeIds: z.array(z.uuid()).max(6).optional(),
  visibility: z.enum(["ORGANIZATION", "PRIVATE"]).optional(),
});

export async function GET(request: Request) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const url = new URL(request.url);
  const param = (name: string) => url.searchParams.get(name) || undefined;
  const number = (name: string) => {
    const value = Number(url.searchParams.get(name));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  };
  const organizationId = check.session.actor.organizationId;
  const filters = {
    subjectId: param("subjectId"),
    chapterId: param("chapterId"),
    type: param("type") as never,
    difficulty: param("difficulty") as never,
    status: param("status") as never,
    search: param("q"),
    limit: number("limit"),
    offset: number("offset"),
  };
  const [{ rows, total }, summary] = await Promise.all([
    searchQuestions(organizationId, filters),
    bankSummary(organizationId, filters),
  ]);

  return ok({ questions: rows, total, summary });
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

  const parsed = QuestionBody.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await createQuestion(check.session.actor, parsed.data);

  if (!result.ok && result.code === "MISFILED") {
    return fail("VALIDATION_FAILED", result.message);
  }
  if (!result.ok && result.code === "INVALID") {
    return fail(
      "VALIDATION_FAILED",
      "This question cannot be saved yet.",
      { problems: result.problems.problems },
    );
  }
  if (!result.ok && result.code === "DUPLICATE") {
    return fail(
      "CONFLICT",
      "You already have this question in your bank.",
      { existingId: result.existingId },
    );
  }

  return ok({ id: result.ok ? result.id : null });
}
