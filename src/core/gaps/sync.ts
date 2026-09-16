import "server-only";
import { withTenant } from "@/db/tenant";
import { detectForClass } from "./detect";

/**
 * Re-run detection for the class an attempt belongs to.
 *
 * Called after the mastery ledger has been updated, and after it rather than
 * inside it: gaps read mastery, so mastery must not know about gaps. Same
 * layering as everywhere else in this codebase — the direction of the arrow is
 * the design.
 *
 * Never throws, for the same reason the mastery sync never throws: this runs on
 * the path where a student submits a paper and a teacher saves a mark, and
 * neither may fail because a derived table could not be recomputed. Detection
 * is a full reconciliation pass, so a skipped run costs nothing that the next
 * one does not fix.
 */
export async function syncGapsForAttempt(
  organizationId: string,
  attemptId: string,
  now = new Date(),
): Promise<void> {
  try {
    const classId = await withTenant(organizationId, async (tx) => {
      const attempt = await tx.attempt.findFirst({
        where: { id: attemptId },
        select: { assignment: { select: { classId: true } } },
      });
      return attempt?.assignment.classId ?? null;
    });
    if (!classId) return;

    await detectForClass(organizationId, classId, now);
  } catch (error) {
    console.error(`[gaps] could not detect for attempt ${attemptId}:`, error);
  }
}
