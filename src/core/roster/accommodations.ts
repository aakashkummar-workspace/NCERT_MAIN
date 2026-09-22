import "server-only";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";

/**
 * Per-student exam accommodations: extra time, and questions read aloud.
 *
 * CBSE grants children with special needs extra time (twenty minutes an hour)
 * and a reader, and a school running tests in this product had no way to give
 * either — a teacher could only lengthen the paper for the whole class.
 *
 * ---------------------------------------------------------------------------
 * The rules
 * ---------------------------------------------------------------------------
 * - **Extra time is applied when a sitting starts**, to the paper's duration
 *   (or the assignment's override). A sitting already under way keeps the
 *   clock it started with, for the reason the clock is stamped at all.
 * - **The window is still the window.** A sitting ends at whichever comes
 *   first, the clock or the window's close — extending past it would release
 *   an AFTER_CLOSE result, and the answer key, while this student is still
 *   writing. So assigning a paper whose window is too short for somebody with
 *   extra time is REFUSED, naming how many and how long they need: the same
 *   refusal a window shorter than the paper itself gets.
 * - **Read-aloud happens on the device** (the browser's speech synthesis) —
 *   no audio is generated or sent anywhere, the voice-input rule.
 * - Visible to staff only. A class list that marks who has an accommodation
 *   is a list of who has a difficulty.
 */

type Actor = { organizationId: string; userId: string; role: string };

/** 33 is CBSE's twenty minutes an hour, rounded to a whole percentage. */
export const EXTRA_TIME_OPTIONS = [0, 25, 33, 50] as const;
export type ExtraTime = (typeof EXTRA_TIME_OPTIONS)[number];

export type Accommodations = { extraTimePercent: number; readAloud: boolean };

export const NONE: Accommodations = { extraTimePercent: 0, readAloud: false };

/** Whole minutes, rounded UP: extra time is never shaved by rounding. */
export function extendedMinutes(minutes: number, extraTimePercent: number): number {
  return Math.ceil((minutes * (100 + extraTimePercent)) / 100);
}

export async function accommodationsFor(
  tx: Prisma.TransactionClient,
  studentUserId: string,
): Promise<Accommodations> {
  const profile = await tx.studentProfile.findFirst({
    where: { userId: studentUserId },
    select: { extraTimePercent: true, readAloud: true },
  });
  return profile ?? NONE;
}

export async function getAccommodations(
  organizationId: string,
  studentUserId: string,
): Promise<Accommodations> {
  return withTenant(organizationId, (tx) => accommodationsFor(tx, studentUserId));
}

export async function setAccommodations(
  actor: Actor,
  studentUserId: string,
  next: Accommodations,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!["OWNER", "ADMIN", "TEACHER"].includes(actor.role)) {
    return { ok: false, message: "Only staff set accommodations." };
  }
  if (!(EXTRA_TIME_OPTIONS as readonly number[]).includes(next.extraTimePercent)) {
    return { ok: false, message: "Extra time is 0, 25, 33 or 50 per cent." };
  }
  const saved = await withTenant(actor.organizationId, async (tx) => {
    const member = await tx.membership.findFirst({
      where: { userId: studentUserId, role: "STUDENT", status: "ACTIVE" },
      select: { id: true },
    });
    if (!member) return false;
    const existing = await tx.studentProfile.findFirst({ where: { userId: studentUserId } });
    if (existing) {
      await tx.studentProfile.update({
        where: { userId: studentUserId },
        data: { extraTimePercent: next.extraTimePercent, readAloud: next.readAloud },
      });
    } else {
      await tx.studentProfile.createMany({
        data: [
          {
            userId: studentUserId,
            organizationId: actor.organizationId,
            extraTimePercent: next.extraTimePercent,
            readAloud: next.readAloud,
          },
        ],
      });
    }
    return true;
  });
  if (!saved) return { ok: false, message: "We could not find that student." };
  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "student.accommodations_set",
    entityType: "user",
    entityId: studentUserId,
    after: next,
  });
  return { ok: true };
}

/**
 * Whether a window is long enough for everybody sitting it, extra time
 * included. Null when it is; otherwise the sentence that says who needs what.
 */
export async function windowShortForExtraTime(
  tx: Prisma.TransactionClient,
  studentIds: string[],
  durationMinutes: number,
  windowMinutes: number,
): Promise<string | null> {
  if (studentIds.length === 0) return null;
  const extended = await tx.studentProfile.findMany({
    where: { userId: { in: studentIds }, extraTimePercent: { gt: 0 } },
    select: { extraTimePercent: true },
  });
  const short = extended.filter((row) => extendedMinutes(durationMinutes, row.extraTimePercent) > windowMinutes);
  if (short.length === 0) return null;
  const needed = Math.max(...short.map((row) => extendedMinutes(durationMinutes, row.extraTimePercent)));
  return `${short.length} ${short.length === 1 ? "student has" : "students have"} extra time and would need ${needed} minutes, but the window is ${Math.round(windowMinutes)}. Lengthen the window so everybody can finish.`;
}
