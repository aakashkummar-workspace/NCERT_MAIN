import "server-only";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { normaliseApaar } from "./parse";

/**
 * A student's APAAR ID (Automated Permanent Academic Account Registry — "One
 * Nation One Student ID").
 *
 * - **It is a record-keeping identifier and nothing else.** It never signs
 *   anybody in, never reaches an AI provider and never goes in a webhook
 *   payload. What it is for is the marks export: an office matching a file to
 *   the national registry by name loses the child whose name is spelled two
 *   ways.
 * - **Twelve digits or refused**, never trimmed into shape. A wrong ID stored
 *   is worse than none, because it is the one the office will trust.
 * - **Unique within a school.** The same ID on two students is the same child
 *   twice, and the refusal says which student already holds it — inside one
 *   school, that is information the teacher already has.
 * - **Clearing it is allowed**, and audited like setting it.
 */

type Actor = { organizationId: string; userId: string; role: string };

export async function getApaar(organizationId: string, studentUserId: string): Promise<string | null> {
  const profile = await withTenant(organizationId, (tx) =>
    tx.studentProfile.findFirst({ where: { userId: studentUserId }, select: { apaarId: true } }),
  );
  return profile?.apaarId ?? null;
}

export async function setApaar(
  actor: Actor,
  studentUserId: string,
  input: string | null,
): Promise<{ ok: true; apaarId: string | null } | { ok: false; code: "INVALID" | "TAKEN" | "NOT_FOUND"; message: string }> {
  if (!["OWNER", "ADMIN", "TEACHER"].includes(actor.role)) {
    return { ok: false, code: "NOT_FOUND", message: "Only staff set an APAAR ID." };
  }
  const blank = input === null || input.trim() === "";
  const apaarId = blank ? null : normaliseApaar(input);
  if (!blank && apaarId === null) {
    return { ok: false, code: "INVALID", message: "An APAAR ID is 12 digits." };
  }

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const member = await tx.membership.findFirst({
      where: { userId: studentUserId, role: "STUDENT", status: "ACTIVE" },
      select: { id: true },
    });
    if (!member) return { kind: "missing" as const };
    if (apaarId) {
      const holder = await tx.studentProfile.findFirst({
        where: { apaarId, userId: { not: studentUserId } },
        select: { userId: true },
      });
      if (holder) {
        const user = await tx.user.findFirst({ where: { id: holder.userId }, select: { fullName: true } });
        return { kind: "taken" as const, name: user?.fullName ?? "another student" };
      }
    }
    const existing = await tx.studentProfile.findFirst({ where: { userId: studentUserId }, select: { userId: true } });
    if (existing) {
      await tx.studentProfile.update({ where: { userId: studentUserId }, data: { apaarId } });
    } else {
      await tx.studentProfile.createMany({
        data: [{ userId: studentUserId, organizationId: actor.organizationId, apaarId }],
      });
    }
    return { kind: "saved" as const };
  });

  if (outcome.kind === "missing") return { ok: false, code: "NOT_FOUND", message: "We could not find that student." };
  if (outcome.kind === "taken") {
    return { ok: false, code: "TAKEN", message: `That APAAR ID is already on ${outcome.name}.` };
  }
  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "student.apaar_set",
    entityType: "user",
    entityId: studentUserId,
    // Whether it was set, not the number itself: the audit view is read in an
    // incident and does not need a national identifier on screen.
    after: { apaarSet: apaarId !== null },
  });
  return { ok: true, apaarId };
}
