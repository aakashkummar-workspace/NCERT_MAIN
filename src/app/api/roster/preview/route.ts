import { z } from "zod";
import { parseRoster } from "@/core/roster/parse";
import { dryRunRoster } from "@/core/roster/add";
import { getClass } from "@/core/classes";
import { studentLimitReason, studentSeats } from "@/core/classes/limits";
import { guard, notFound } from "../../_lib/guard";
import { fail, failValidation, ok } from "../../_lib/respond";

export const runtime = "nodejs";

const Body = z.object({
  classId: z.uuid(),
  text: z.string().max(200_000),
});

/**
 * The dry run. Writes nothing, and every reason it reports is a reason the
 * commit would skip the same row — both run the same parser and the same row
 * checks. A preview with its own logic is a preview that lies.
 */
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

  const { organizationId } = check.session.actor;
  const target = await getClass(organizationId, parsed.data.classId);
  if (!target) return notFound("class");

  const roster = parseRoster(parsed.data.text);
  const seats = await studentSeats(organizationId);
  const reason = studentLimitReason(seats);
  const outcomes = await dryRunRoster(
    organizationId,
    parsed.data.classId,
    roster.students,
    { remaining: seats.remaining, reason },
  );

  return ok({
    // How many rows the plan's student limit would turn away, so the preview
    // says it before the teacher presses Add.
    overPlanLimit: outcomes.filter((o) => o.status === "skipped" && o.reason === reason).length,
    studentLimit: seats.limit,
    detected: roster.detected,
    problems: roster.problems,
    duplicateNames: roster.duplicateNames,
    outcomes,
    willAdd: outcomes.filter((o) => o.status === "added").length,
    willSkip: outcomes.filter((o) => o.status === "skipped").length,
  });
}
