import { questionPickerOptions } from "@/core/curriculum/picker";
import { guard } from "../../_lib/guard";
import { ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * The chapters and learning outcomes a question can be filed against.
 *
 * Curriculum is global, but a tenant sees only ONE board's worth of it — the
 * board on their organization, resolved from the session inside
 * questionPickerOptions(). There is no board parameter here and there must not
 * be one: a caller who could name a board could file questions against a
 * syllabus their school does not teach.
 *
 * Each chapter carries its subjectId, so a caller can send a coherent
 * (subject, chapter, outcome) triple. The server checks that anyway — see
 * checkCurriculumFit — but a client that has the mapping never triggers it.
 */
export async function GET() {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { chapters, outcomes } = await questionPickerOptions(
    check.session.actor.organizationId,
  );
  return ok({ chapters, outcomes });
}
