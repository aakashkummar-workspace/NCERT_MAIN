import { z } from "zod";
import { createAssignment, listAssignments } from "@/core/assignments";
import { guard } from "../_lib/guard";
import { fail, failValidation, ok } from "../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  assessmentId: z.uuid(),
  classId: z.uuid(),
  // ISO strings, so the client can send the exact instant it means rather than
  // a local-time string the server has to guess a zone for.
  opensAt: z.iso.datetime(),
  closesAt: z.iso.datetime(),
  durationOverrideMinutes: z.number().int().min(5).max(360).nullable().optional(),
  maxAttempts: z.number().int().min(1).max(5).default(1),
  resultsPolicy: z
    .enum(["IMMEDIATE", "AFTER_CLOSE", "MANUAL"])
    .default("AFTER_CLOSE"),
  studentUserIds: z.array(z.uuid()).max(500).optional(),
  deliveryMode: z.enum(["ONLINE", "PAPER"]).default("ONLINE"),
});

export async function GET(request: Request) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const url = new URL(request.url);
  const classId = url.searchParams.get("classId") ?? undefined;
  const assessmentId = url.searchParams.get("assessmentId") ?? undefined;
  // A malformed filter is a bad request, not a database error.
  for (const value of [classId, assessmentId]) {
    if (value !== undefined && !z.uuid().safeParse(value).success) {
      return fail("VALIDATION_FAILED", "That is not an id we recognise.");
    }
  }
  const assignments = await listAssignments(
    check.session.actor.organizationId,
    { classId, assessmentId },
  );

  return ok({ assignments });
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

  const result = await createAssignment(check.session.actor, {
    ...parsed.data,
    opensAt: new Date(parsed.data.opensAt),
    closesAt: new Date(parsed.data.closesAt),
  });

  if (!result.ok) {
    return fail("VALIDATION_FAILED", result.message, {
      problems: result.problems,
    });
  }

  return ok({ id: result.id });
}
