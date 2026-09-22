import { z } from "zod";
import { addAnswerImage } from "@/core/marking-assist";
import { guard, notFound } from "../../../_lib/guard";
import { fail, ok } from "../../../_lib/respond";
import { readImageBody } from "../../../_lib/image-body";

export const runtime = "nodejs";

/** A teacher adds a photo of a paper script to a written answer. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ answerId: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { answerId } = await params;
  if (!z.uuid().safeParse(answerId).success) return notFound("answer");

  const body = await readImageBody(request);
  if (!body.ok) return fail("VALIDATION_FAILED", body.message);

  const result = await addAnswerImage(check.session.actor, { answerId }, body.bytes);
  if (!result.ok) {
    if (result.code === "NOT_FOUND") return notFound("answer");
    if (result.code === "CONFLICT") return fail("CONFLICT", result.message);
    return fail("VALIDATION_FAILED", result.message);
  }
  return ok({ id: result.id });
}
