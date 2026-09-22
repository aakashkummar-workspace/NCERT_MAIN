import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { readAnswerImage, removeAnswerImage } from "@/core/marking-assist";
import { fail, ok } from "../../_lib/respond";
import { imageResponse } from "../../_lib/image-body";

export const runtime = "nodejs";

const NOT_FOUND = () => fail("NOT_FOUND", "We could not find that photo.");

/**
 * One photo of a written answer: to staff, or to the student who wrote it.
 * Everybody else — a parent included — gets the 404 a missing photo gets.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ imageId: string }> },
) {
  const session = await getSession();
  if (!session) return NOT_FOUND();
  const { imageId } = await params;
  if (!z.uuid().safeParse(imageId).success) return NOT_FOUND();

  const image = await readAnswerImage(session.actor, imageId);
  return image ? imageResponse(image) : NOT_FOUND();
}

/** Its uploader may remove it — a student only while still writing. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ imageId: string }> },
) {
  const session = await getSession();
  if (!session) return NOT_FOUND();
  const { imageId } = await params;
  if (!z.uuid().safeParse(imageId).success) return NOT_FOUND();

  const removed = await removeAnswerImage(session.actor, imageId);
  return removed ? ok({ removed: true }) : NOT_FOUND();
}
