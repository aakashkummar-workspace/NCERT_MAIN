import { getPlayer } from "@/core/attempts";
import { guardStudent } from "../../../_lib/student";
import { fail, ok } from "../../../_lib/respond";

export const runtime = "nodejs";

/**
 * Authoritative server time.
 *
 * The client displays `expiresAt - serverTime`, corrected for observed drift.
 * The countdown is never accumulated locally: a phone that backgrounds the tab
 * for forty minutes must come back with the correct remaining time, and a
 * counted clock will not.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const check = await guardStudent();
  if (!check.ok) return check.response;

  const { id } = await params;
  const player = await getPlayer(
    {
      organizationId: check.session.actor.organizationId,
      userId: check.session.actor.userId,
    },
    id,
  );
  if (!player) return fail("NOT_FOUND", "We could not find that test.");

  return ok({
    serverTime: player.serverTime,
    expiresAt: player.expiresAt,
    remainingMs: player.remainingMs,
    status: player.status,
  });
}
