import "server-only";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";

/**
 * The weekly WhatsApp digest for parents.
 *
 * - **The parent opts in, from their own page.** Nobody else can: WhatsApp's
 *   rules and ours both need the phone's owner to ask.
 * - **Read through the parent's own view**, re-derived at send time, so a
 *   revoked link or a withdrawn consent stops the next message with nobody
 *   having to remember to.
 * - **One per child per week.** The ledger's unique key is the week, so a job
 *   run twice sends once.
 * - **Nothing new, nothing sent** — see ./build.ts.
 */

type Parent = { organizationId: string; userId: string };

export async function digestState(parent: Parent, studentUserId: string): Promise<boolean | null> {
  const link = await withTenant(parent.organizationId, (tx) =>
    tx.parentStudentLink.findFirst({
      where: { parentUserId: parent.userId, studentUserId, consentGrantedAt: { not: null }, revokedAt: null },
      select: { whatsappDigestAt: true },
    }),
  );
  return link ? link.whatsappDigestAt !== null : null;
}

export async function setDigest(parent: Parent, studentUserId: string, on: boolean): Promise<boolean> {
  const updated = await withTenant(parent.organizationId, (tx) =>
    tx.parentStudentLink.updateMany({
      where: { parentUserId: parent.userId, studentUserId, consentGrantedAt: { not: null }, revokedAt: null },
      data: { whatsappDigestAt: on ? new Date() : null },
    }),
  );
  if (updated.count === 0) return false;
  await writeAudit({
    organizationId: parent.organizationId,
    actorUserId: parent.userId,
    actorRole: "PARENT",
    action: on ? "parent.whatsapp_digest_on" : "parent.whatsapp_digest_off",
    entityType: "user",
    entityId: studentUserId,
  });
  return true;
}

