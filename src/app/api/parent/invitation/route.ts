import { previewInvitation } from "@/core/parent/link";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * What an invitation link shows before anybody signs in.
 *
 * Unauthenticated by necessity — the person opening it has no account yet — so
 * it returns only what a parent needs to recognise the link is theirs: the
 * child's name, the centre's name, and a masked hint of the number the code
 * will go to. Nothing about the child's work.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return fail("NOT_FOUND", "We could not find that.");

  const preview = await previewInvitation(token);
  if (!preview.ok) return fail("NOT_FOUND", preview.message);

  return ok(preview);
}
