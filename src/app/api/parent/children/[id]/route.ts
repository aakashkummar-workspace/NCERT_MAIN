import { childView } from "@/core/parent/read";
import { guardParent } from "../../../_lib/parent";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * One child's performance.
 *
 * The id in the path is a claim, not permission — `childView` re-derives the
 * link before it reads anything, and returns null when there is none. A parent
 * guessing another family's student id gets the same 404 as a parent guessing
 * a uuid that never existed.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardParent();
  if (!check.ok) return check.response;

  const { id } = await params;
  const child = await childView(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    id,
  );
  if (!child) return fail("NOT_FOUND", "We could not find that.");

  return ok(child);
}
