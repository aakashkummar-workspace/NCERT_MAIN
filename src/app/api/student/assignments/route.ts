import { studentAssignments } from "@/core/attempts/student-view";
import { guardStudent } from "../../_lib/student";
import { ok } from "../../_lib/respond";

export const runtime = "nodejs";

export async function GET() {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const assignments = await studentAssignments(
    check.session.actor.organizationId,
    check.session.actor.userId,
  );

  return ok({ assignments });
}
