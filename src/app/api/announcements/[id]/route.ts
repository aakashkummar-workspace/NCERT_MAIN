import { deleteAnnouncement } from "@/core/announcements";
import { guard, notFound } from "../../_lib/guard";
import { fail, ok } from "../../_lib/respond";

export const runtime = "nodejs";

/**
 * Remove an announcement. A stamp, not a delete — see `deleteAnnouncement`.
 * Removing one twice is a 404 the second time: there is nothing left showing.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guard("organization:read");
  if (!check.ok) return check.response;

  const { id } = await params;
  const result = await deleteAnnouncement(check.session.actor, id);
  if (!result.ok) {
    return result.reason === "forbidden"
      ? fail("FORBIDDEN", result.message)
      : notFound("announcement");
  }
  return ok({ deleted: true });
}
