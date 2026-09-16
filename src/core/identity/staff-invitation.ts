import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
// Opening `/join/<token>` happens before the invitee has a session in the
// inviting organization — the pre-tenant seam again. The read is the narrow
// SECURITY DEFINER `app_auth_staff_invitation`; everything after it runs inside
// the organization the invitation names.
import {
  findUserForAuth,
  identifierTaken,
  staffInvitationForAcceptance,
} from "@/db/unscoped";
import type { Role } from "./authorize";
import { writeAudit } from "./audit";
import { checkPassword, hashPassword, verifyPassword } from "./password";
import { createSessionToken, sessionExpiry } from "./session";

/**
 * Accepting an invitation to join an institute's staff.
 *
 * ---------------------------------------------------------------------------
 * It works once
 * ---------------------------------------------------------------------------
 * The invitation is claimed with `accepted_at is null` in the same transaction
 * that creates the membership, so two presses — or two people holding the same
 * forwarded link — produce one membership. Expired, cancelled and accepted
 * links all get the same answer, because distinguishing them tells somebody
 * holding a stolen link which one it was.
 *
 * ---------------------------------------------------------------------------
 * The account joining is the address invited
 * ---------------------------------------------------------------------------
 * An owner invited a named email address. Letting the holder of the link sign
 * in as somebody else would let a forwarded link add whoever it reached.
 *
 * ---------------------------------------------------------------------------
 * Only an owner may create another owner — at acceptance too
 * ---------------------------------------------------------------------------
 * `inviteStaff` refuses an OWNER invitation from a non-owner, but two weeks
 * can pass between sending and accepting. An owner invitation whose sender is
 * no longer an active owner is refused rather than honoured, because honouring
 * it would let a demoted owner's old link keep minting owners.
 */

export type StaffInvitePreview =
  | { ok: true; organizationName: string; role: string; email: string; accountExists: boolean }
  | { ok: false; message: string };

const INVALID = "This invitation is not valid any more. Ask whoever invited you for a new one.";

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function previewStaffInvitation(
  token: string,
  now = new Date(),
): Promise<StaffInvitePreview> {
  const row = await staffInvitationForAcceptance(hashToken(token), now);
  if (!row) return { ok: false, message: INVALID };
  return {
    ok: true,
    organizationName: row.organization_name,
    role: row.role,
    email: row.email,
    // Revealed only to somebody holding a live invitation FOR that address,
    // and it decides which form to show — sign in, or create a password.
    accountExists: await identifierTaken(row.email, null),
  };
}

export type JoinInput =
  | { mode: "signin"; email: string; password: string }
  | { mode: "create"; email: string; password: string; fullName: string };

export type JoinResult =
  | { ok: true; token: string; expiresAt: Date; organizationId: string; role: Role }
  | { ok: false; message: string };

export async function acceptStaffInvitation(
  token: string,
  input: JoinInput,
  meta: { userAgent?: string; ip?: string } = {},
  now = new Date(),
): Promise<JoinResult> {
  const invitation = await staffInvitationForAcceptance(hashToken(token), now);
  if (!invitation) return { ok: false, message: INVALID };

  const email = input.email.trim().toLowerCase();
  if (email !== invitation.email.toLowerCase()) {
    return {
      ok: false,
      message: `This invitation was sent to ${invitation.email}. Use that address.`,
    };
  }

  let userId: string;
  let newUser: { fullName: string; passwordHash: string } | null = null;

  if (input.mode === "signin") {
    const user = await findUserForAuth(email);
    const valid =
      user?.password_hash && user.status === "ACTIVE"
        ? await verifyPassword(user.password_hash, input.password)
        : false;
    if (!user || !valid) {
      return {
        ok: false,
        message: "That email and password do not match. Check both and try again.",
      };
    }
    userId = user.id;
  } else {
    const fullName = input.fullName.trim();
    if (fullName.length < 2) return { ok: false, message: "Tell us your name." };
    const password = checkPassword(input.password);
    if (!password.ok) return { ok: false, message: password.message };
    if (await identifierTaken(email, null)) {
      return {
        ok: false,
        message: "That email already has an account. Sign in with it instead.",
      };
    }
    userId = randomUUID();
    newUser = { fullName, passwordHash: await hashPassword(input.password) };
  }

  const organizationId = invitation.organization_id;
  const role = invitation.role as Role;
  const session = createSessionToken();
  const expiresAt = sessionExpiry(role);

  const outcome = await withTenant<
    { ok: true; membershipId: string; reactivated: boolean } | { ok: false; message: string }
  >(organizationId, async (tx) => {
    const row = await tx.invitation.findFirst({
      where: { id: invitation.invitation_id },
      select: { id: true, invitedById: true, role: true },
    });
    if (!row) return { ok: false, message: INVALID };

    if (row.role === "OWNER") {
      const inviter = await tx.membership.findFirst({
        where: { userId: row.invitedById, role: "OWNER", status: "ACTIVE" },
      });
      if (!inviter) {
        return {
          ok: false,
          message:
            "Only an owner can make another owner, and whoever sent this is no longer one. Ask a current owner for a new invitation.",
        };
      }
    }

    const existing = newUser
      ? null
      : await tx.membership.findFirst({ where: { userId } });
    if (existing && existing.status === "ACTIVE") {
      return {
        ok: false,
        message: "You are already a member here. Sign in instead.",
      };
    }
    if (existing && !["OWNER", "ADMIN", "TEACHER"].includes(existing.role)) {
      // One membership per person per organization. A parent or student
      // account cannot also be staff in the same school — that would put a
      // child's parent inside the teacher workspace that lists every child.
      return {
        ok: false,
        message:
          "That account belongs to a student or parent here, so it cannot join as staff. Use a different email address.",
      };
    }

    // Claimed first, atomically. The loser of a race matches no row and
    // writes nothing, because this whole transaction rolls back with it.
    const claimed = await tx.invitation.updateMany({
      where: { id: row.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now },
    });
    if (claimed.count !== 1) throw new ClaimLost();

    if (newUser) {
      // createMany with an application-generated id, not create(): the
      // SELECT policy on `users` resolves through membership, and Postgres
      // applies it to INSERT ... RETURNING before the membership exists.
      await tx.user.createMany({
        data: [
          {
            id: userId,
            email,
            passwordHash: newUser.passwordHash,
            fullName: newUser.fullName,
            status: "ACTIVE",
          },
        ],
      });
    }

    let membershipId: string;
    let reactivated = false;
    if (existing) {
      // A suspended colleague invited back. The same row, so every paper
      // they wrote before stays attributed to the same membership.
      await tx.membership.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", role: row.role, joinedAt: now },
      });
      membershipId = existing.id;
      reactivated = true;
    } else {
      membershipId = randomUUID();
      await tx.membership.createMany({
        data: [
          {
            id: membershipId,
            organizationId,
            userId,
            role: row.role,
            status: "ACTIVE",
            joinedAt: now,
          },
        ],
      });
    }

    await tx.session.create({
      data: {
        userId,
        organizationId,
        membershipId,
        tokenHash: new Uint8Array(session.hash),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expiresAt,
      },
    });

    return { ok: true, membershipId, reactivated };
  }).catch((error: unknown) => {
    if (error instanceof ClaimLost) return { ok: false as const, message: INVALID };
    throw error;
  });

  if (!outcome.ok) return outcome;

  await writeAudit({
    organizationId,
    actorUserId: userId,
    actorRole: role,
    action: "member.joined",
    entityType: "membership",
    entityId: outcome.membershipId,
    after: {
      invitationId: invitation.invitation_id,
      role,
      newAccount: newUser !== null,
      reactivated: outcome.reactivated,
    },
    ...meta,
  });

  return { ok: true, token: session.raw, expiresAt, organizationId, role };
}

/** Thrown to roll the transaction back when another acceptance won the claim. */
class ClaimLost extends Error {}
