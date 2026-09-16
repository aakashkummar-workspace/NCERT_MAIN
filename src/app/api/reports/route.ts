import { z } from "zod";
import { generateForClass, generateReport, listReports } from "@/core/reports";
import { guard } from "../_lib/guard";
import { fail, failValidation, ok } from "../_lib/respond";

export const runtime = "nodejs";

/**
 * Generating reports.
 *
 * One student or a whole class — the second is the real workflow, because a
 * teacher does not write one report, they do a class before parents' evening.
 *
 * There is no PATCH and no DELETE, and that is the design. A report is written
 * once and never edited: a parent shown "62% across 4 of 9 ideas" in September
 * must be able to bring that sheet in December and have it still say that.
 * Running it again SUPERSEDES — a new row, with the old one kept, so "what did
 * we tell this parent in September" always has an answer.
 */

const Body = z
  .object({
    studentUserId: z.string().uuid().optional(),
    classId: z.string().uuid().optional(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
  })
  .refine((value) => Boolean(value.studentUserId) !== Boolean(value.classId), {
    message: "Name a student or a class, not both.",
  });

export async function POST(request: Request) {
  // `organization:read` is the staff boundary: OWNER, ADMIN and TEACHER hold
  // it and STUDENT and PARENT do not. A parent reaches reports about their own
  // child through core/parent/read.ts, which checks consent — never here.
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  const { session } = check;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failValidation(parsed.error);

  const periodStart = new Date(parsed.data.periodStart);
  const periodEnd = new Date(parsed.data.periodEnd);
  if (periodEnd <= periodStart) {
    return fail("VALIDATION_FAILED", "The period ends before it starts.");
  }

  const actor = {
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
  };

  if (parsed.data.classId) {
    const result = await generateForClass(actor, {
      classId: parsed.data.classId,
      periodStart,
      periodEnd,
    });
    if (!result.ok) return fail("CONFLICT", result.message);
    return ok(result, { status: 201 });
  }

  const result = await generateReport(actor, {
    studentUserId: parsed.data.studentUserId!,
    periodStart,
    periodEnd,
  });
  if (!result.ok) {
    return fail(result.reason === "not-found" ? "NOT_FOUND" : "CONFLICT", result.message);
  }
  return ok(result, { status: 201 });
}

export async function GET(request: Request) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;
  const { session } = check;

  const url = new URL(request.url);
  const studentUserId = url.searchParams.get("studentUserId") ?? undefined;
  const classId = url.searchParams.get("classId") ?? undefined;
  // A malformed filter is a bad request, not a database error.
  for (const value of [studentUserId, classId]) {
    if (value !== undefined && !z.uuid().safeParse(value).success) {
      return fail("VALIDATION_FAILED", "That is not an id we recognise.");
    }
  }

  const rows = await listReports(
    {
      organizationId: session.actor.organizationId,
      userId: session.actor.userId,
    },
    { studentUserId, classId },
  );
  return ok({ reports: rows });
}
