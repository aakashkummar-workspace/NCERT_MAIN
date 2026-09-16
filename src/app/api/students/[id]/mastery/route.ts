import { studentProfile } from "@/core/analytics/student";
import { guard, notFound } from "../../../_lib/guard";
import { ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * One student, as a teacher reads them: what they scored and what we believe
 * they know, side by side.
 *
 * 404 for anybody who is not an active student of this organization — being
 * able to name a user is not the same as them being your student, and the
 * `users` table is global.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const profile = await studentProfile(check.session.actor.organizationId, id);
  if (!profile) return notFound("student");

  return ok(profile);
}
