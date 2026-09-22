import { z } from "zod";
import { addAnswerImage } from "@/core/marking-assist";
import { guardStudent } from "../../../_lib/student";
import { fail, ok } from "../../../_lib/respond";
import { readImageBody } from "../../../_lib/image-body";

export const runtime = "nodejs";

/**
 * A student adds a photo of their written working to an answer, while the
 * paper is being written. `?question=` names the question on this paper.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const { id } = await params;
  const question = new URL(request.url).searchParams.get("question") ?? "";
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(question).success) {
    return fail("NOT_FOUND", "We could not find that answer.");
  }

  const body = await readImageBody(request);
  if (!body.ok) return fail("VALIDATION_FAILED", body.message);

  const result = await addAnswerImage(
    check.session.actor,
    { attemptId: id, assessmentQuestionId: question },
    body.bytes,
  );
  if (!result.ok) {
    if (result.code === "NOT_FOUND") return fail("NOT_FOUND", result.message);
    if (result.code === "CONFLICT") return fail("CONFLICT", result.message);
    return fail("VALIDATION_FAILED", result.message);
  }
  return ok({ id: result.id });
}
