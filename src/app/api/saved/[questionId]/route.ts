import { unsaveQuestion } from "@/core/saved";
import { guardStudent } from "../../_lib/student";
import { ok } from "../../_lib/respond";
import { notFound } from "../../_lib/guard";

export const runtime = "nodejs";

/** Unsave. Removing a bookmark that is not there is still `saved: false`. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ questionId: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const { questionId } = await params;
  const result = await unsaveQuestion(check.session.actor, questionId);
  if (!result.ok) return notFound("question");
  return ok({ saved: false });
}
