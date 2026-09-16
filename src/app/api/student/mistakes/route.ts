import { listMistakes, mistakeSummary } from "@/core/mistakes/read";
import { guardStudent } from "../../_lib/student";
import { ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * A student's own wrong answers.
 *
 * Scoped to the session's own user id, with no parameter that could name
 * somebody else. That is not only tenancy: the mistake bank is deliberately
 * outside a parent's read scope too — see SECURITY_MODEL.md — and a route that
 * accepted `?studentId=` would be the first crack in that.
 */
export async function GET(request: Request) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const conceptId = url.searchParams.get("conceptId");

  const [mistakes, summary] = await Promise.all([
    listMistakes(
      check.session.actor.organizationId,
      check.session.actor.userId,
      {
        status:
          status === "UNRESOLVED" || status === "RETRIED" || status === "RESOLVED"
            ? status
            : undefined,
        conceptId: conceptId ?? undefined,
      },
    ),
    mistakeSummary(
      check.session.actor.organizationId,
      check.session.actor.userId,
    ),
  ]);

  return ok({ mistakes, summary });
}
