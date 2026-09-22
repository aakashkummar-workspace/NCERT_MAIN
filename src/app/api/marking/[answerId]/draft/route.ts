import { z } from "zod";
import { draftMarks } from "@/core/marking-assist";
import { guard, notFound } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Ask a model for a draft of this answer's marks. A POST, and pressed per
 * answer: a page that drafted on load would bill a teacher for opening it.
 * What comes back is a suggestion — see core/marking-assist.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ answerId: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { answerId } = await params;
  if (!z.uuid().safeParse(answerId).success) return notFound("answer");

  const result = await draftMarks(check.session.actor, answerId);
  if (!result.ok) {
    if (result.code === "NOT_FOUND") return notFound("answer");
    if (result.code === "INVALID") return fail("VALIDATION_FAILED", result.message);
    return fail("CONFLICT", result.message);
  }
  return ok({ draft: result.draft });
}
