import "server-only";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";

/**
 * Teachers, invitations, and who may do what.
 *
 * ---------------------------------------------------------------------------
 * An organization always keeps one owner
 * ---------------------------------------------------------------------------
 * The rule that shapes this file. An institute whose last OWNER is demoted or
 * removed has nobody who can manage billing, invite anybody, or undo the
 * mistake — and no route back except somebody with database access. Every path
 * that could produce that state refuses instead.
 *
 * ---------------------------------------------------------------------------
 * Removal is a status, not a delete
 * ---------------------------------------------------------------------------
 * A teacher's assessments, marking and audit rows all reference them. Deleting
 * the membership would either cascade that away or leave it dangling; setting
 * the status keeps every paper they wrote attributable, which is what somebody
 * asking "who marked this" needs a year later.
 */

export type Actor = { organizationId: string; userId: string; role: string };
export type StaffRole = "OWNER" | "ADMIN" | "TEACHER";

const TOKEN_BYTES = 32;
export const INVITE_TTL_MS = 14 * 24 * 3600_000;

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export type MemberRow = {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string | null;
  role: string;
  status: string;
  joinedAt: Date | null;
  lastLoginAt: Date | null;
};

export async function listStaff(organizationId: string): Promise<MemberRow[]> {
  return withTenant(organizationId, async (tx) => {
    const memberships = await tx.membership.findMany({
      where: { role: { in: ["OWNER", "ADMIN", "TEACHER"] } },
      orderBy: { joinedAt: "asc" },
    });
    if (memberships.length === 0) return [];

    const users = await tx.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, fullName: true, email: true, lastLoginAt: true },
    });
    const byId = new Map(users.map((user) => [user.id, user]));

    return memberships.map((membership) => {
      const user = byId.get(membership.userId);
      return {
        membershipId: membership.id,
        userId: membership.userId,
        fullName: user?.fullName ?? "Unknown",
        email: user?.email ?? null,
        role: membership.role,
        status: membership.status,
        joinedAt: membership.joinedAt,
        lastLoginAt: user?.lastLoginAt ?? null,
      };
    });
  });
}

export type PendingInvite = {
  id: string;
  email: string | null;
  role: string;
  expiresAt: Date;
  expired: boolean;
  createdAt: Date;
};

export async function pendingStaffInvites(
  organizationId: string,
  now = new Date(),
): Promise<PendingInvite[]> {
  const invitations = await withTenant(organizationId, (tx) =>
    tx.invitation.findMany({
      where: {
        role: { in: ["OWNER", "ADMIN", "TEACHER"] },
        acceptedAt: null,
        revokedAt: null,
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return invitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    // Shown rather than filtered out: an owner who sent an invitation a month
    // ago and sees nothing assumes they never sent it.
    expired: invitation.expiresAt <= now,
    createdAt: invitation.createdAt,
  }));
}

export type InviteResult =
  | { ok: true; invitationId: string; token: string; expiresAt: Date }
  | { ok: false; message: string };

export async function inviteStaff(
  actor: Actor,
  input: { email: string; role: StaffRole },
  now = new Date(),
): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, message: "That does not look like an email address." };
  }

  // Only an owner may make another owner. An admin who could promote to owner
  // could promote themselves, which makes the distinction between the two roles
  // decorative.
  if (input.role === "OWNER" && actor.role !== "OWNER") {
    return {
      ok: false,
      message: "Only an owner can invite another owner.",
    };
  }

  const outcome = await withTenant<InviteResult>(
    actor.organizationId,
    async (tx) => {
      const existing = await tx.invitation.findFirst({
        where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      });
      if (existing) {
        return {
          ok: false,
          message:
            "There is already a live invitation for that address. Cancel it first if you want to change the role.",
        };
      }

      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      const id = randomUUID();
      await tx.invitation.create({
        data: {
          id,
          organizationId: actor.organizationId,
          email,
          role: input.role,
          tokenHash: new Uint8Array(hashToken(token)),
          invitedById: actor.userId,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        },
      });

      return {
        ok: true,
        invitationId: id,
        // Returned once, to be sent. Only the hash is stored.
        token,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      };
    },
  );

  if (outcome.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "member.invited",
      entityType: "invitation",
      entityId: outcome.invitationId,
      after: { email, role: input.role },
    });
  }

  return outcome;
}

export type MemberResult = { ok: true } | { ok: false; message: string };

export async function cancelInvite(
  actor: Actor,
  invitationId: string,
  now = new Date(),
): Promise<MemberResult> {
  const outcome = await withTenant<MemberResult>(
    actor.organizationId,
    async (tx) => {
      const invitation = await tx.invitation.findFirst({
        where: { id: invitationId, acceptedAt: null },
      });
      if (!invitation) {
        return { ok: false, message: "We could not find that invitation." };
      }
      await tx.invitation.update({
        where: { id: invitationId },
        data: { revokedAt: now },
      });
      return { ok: true };
    },
  );

  if (outcome.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "member.invite_cancelled",
      entityType: "invitation",
      entityId: invitationId,
    });
  }
  return outcome;
}

/**
 * Change somebody's role.
 *
 * Three refusals, and each one exists because the state it prevents has no way
 * back through the product.
 */
export async function changeRole(
  actor: Actor,
  membershipId: string,
  role: StaffRole,
): Promise<MemberResult> {
  const outcome = await withTenant<MemberResult & { before?: string }>(
    actor.organizationId,
    async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { id: membershipId },
      });
      if (!membership || !["OWNER", "ADMIN", "TEACHER"].includes(membership.role)) {
        return { ok: false, message: "We could not find that person." };
      }

      if (membership.userId === actor.userId) {
        // Changing your own role is how somebody locks themselves out by
        // accident, and an owner who wants to step down should be handing over
        // to a named person rather than demoting themselves and hoping.
        return {
          ok: false,
          message:
            "You cannot change your own role. Ask another owner to do it.",
        };
      }

      if (role === "OWNER" && actor.role !== "OWNER") {
        return { ok: false, message: "Only an owner can make another owner." };
      }

      if (membership.role === "OWNER" && role !== "OWNER") {
        const owners = await tx.membership.count({
          where: { role: "OWNER", status: "ACTIVE" },
        });
        if (owners <= 1) {
          // No owner means nobody who can manage billing, invite anybody, or
          // undo this — and no route back except database access.
          return {
            ok: false,
            message:
              "This is the only owner. Make somebody else an owner first, then change this one.",
          };
        }
      }

      await tx.membership.update({ where: { id: membershipId }, data: { role } });
      return { ok: true, before: membership.role };
    },
  );

  if (outcome.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "member.role_changed",
      entityType: "membership",
      entityId: membershipId,
      before: { role: outcome.before },
      after: { role },
    });
  }
  return { ok: outcome.ok, ...(outcome.ok ? {} : { message: outcome.message }) } as MemberResult;
}

/**
 * Take somebody's access away.
 *
 * A status change, never a delete: their assessments, their marking and their
 * audit rows all point at them, and "who marked this" is a question that gets
 * asked a year later.
 */
export async function removeStaff(
  actor: Actor,
  membershipId: string,
): Promise<MemberResult> {
  const outcome = await withTenant<MemberResult>(
    actor.organizationId,
    async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { id: membershipId },
      });
      if (!membership || !["OWNER", "ADMIN", "TEACHER"].includes(membership.role)) {
        return { ok: false, message: "We could not find that person." };
      }

      if (membership.userId === actor.userId) {
        return { ok: false, message: "You cannot remove yourself." };
      }

      if (membership.role === "OWNER") {
        const owners = await tx.membership.count({
          where: { role: "OWNER", status: "ACTIVE" },
        });
        if (owners <= 1) {
          return {
            ok: false,
            message:
              "This is the only owner. Make somebody else an owner before removing this one.",
          };
        }
      }

      // SUSPENDED, which is what the enum calls it: access off, record intact.
      // The product says "remove" because that is what an owner means; the
      // data says suspended because nothing is actually removed, and that
      // difference is the point.
      await tx.membership.update({
        where: { id: membershipId },
        data: { status: "SUSPENDED" },
      });

      // Their sessions go with their access. Leaving them signed in until the
      // cookie expires is the gap between "removed" and "cannot get in".
      await tx.session.deleteMany({ where: { userId: membership.userId } });

      return { ok: true };
    },
  );

  if (outcome.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "member.removed",
      entityType: "membership",
      entityId: membershipId,
    });
  }
  return outcome;
}
