import "server-only";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { hashCode } from "@/core/identity/student-auth";
import { createSessionToken, sessionExpiry } from "@/core/identity/session";
// An invitation is opened before any session exists, which is the pre-tenant
// seam. `app_auth_invitation` is the narrow SECURITY DEFINER read for it, and
// this module is on the ESLint exemption list alongside identity and roster.
import {
  findUserForAuth,
  invitationForAcceptance,
  verifyCodeOnly,
} from "@/db/unscoped";

/**
 * Inviting a parent, and the consent that follows.
 *
 * ---------------------------------------------------------------------------
 * The invitation grants nothing
 * ---------------------------------------------------------------------------
 * A teacher creating an invitation creates a row with `consentGrantedAt` null,
 * and a link in that state is invisible to every read in `core/parent/read.ts`.
 * Access begins when the person holding the phone verifies it, which is what
 * makes it safe to send the link over SMS to a number a teacher typed.
 *
 * ---------------------------------------------------------------------------
 * The token is never stored
 * ---------------------------------------------------------------------------
 * Only its SHA-256, exactly as sessions and login codes do it. A database leak
 * must not be a set of working invitation links to children's records.
 *
 * ---------------------------------------------------------------------------
 * Revocation is a stamp
 * ---------------------------------------------------------------------------
 * Never a delete. "Who could see this child's results, and until when" is a
 * question that gets asked after something has gone wrong, and a deleted row
 * cannot answer it.
 */

export type Actor = { organizationId: string; userId: string; role: string };

export type Relationship = "FATHER" | "MOTHER" | "GUARDIAN";

/** Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;

/** A week. Long enough for a parent to get to it, short enough to expire. */
export const INVITE_TTL_MS = 7 * 24 * 3600_000;

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export type InviteResult =
  | { ok: true; invitationId: string; token: string; expiresAt: Date }
  | { ok: false; message: string };

export async function inviteParent(
  actor: Actor,
  input: { studentUserId: string; phone: string; relationship: Relationship },
  now = new Date(),
): Promise<InviteResult> {
  if (!isUuid(input.studentUserId)) {
    return { ok: false, message: "We could not find that student." };
  }
  const phone = input.phone.replace(/\D/g, "").slice(-10);
  if (phone.length !== 10) {
    return { ok: false, message: "Enter a ten-digit mobile number." };
  }

  const outcome = await withTenant<InviteResult>(
    actor.organizationId,
    async (tx) => {
      // The student must be this organization's. A teacher cannot invite a
      // parent to a child they do not teach, and the membership check is what
      // says so — being able to name a user id is not the same as having them.
      const membership = await tx.membership.findFirst({
        where: { userId: input.studentUserId, role: "STUDENT", status: "ACTIVE" },
      });
      if (!membership) {
        return { ok: false, message: "We could not find that student." };
      }

      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      const id = randomUUID();

      await tx.invitation.create({
        data: {
          id,
          organizationId: actor.organizationId,
          phone,
          role: "PARENT",
          studentUserId: input.studentUserId,
          relationship: input.relationship,
          tokenHash: new Uint8Array(hashToken(token)),
          invitedById: actor.userId,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        },
      });

      return {
        ok: true,
        invitationId: id,
        // Returned once, to be sent. Never readable again from anywhere.
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
      action: "parent.invited",
      entityType: "invitation",
      entityId: outcome.invitationId,
      // The number is deliberately not in the audit payload: this row is read
      // by a platform admin during an incident, and a child's guardian's phone
      // number is not what they are looking for.
      after: { studentUserId: input.studentUserId, relationship: input.relationship },
    });
  }

  return outcome;
}

export type InvitePreview =
  | {
      ok: true;
      studentName: string;
      organizationName: string;
      relationship: string;
      /** Masked. Enough to recognise, not enough to be a disclosure. */
      phoneHint: string;
    }
  | { ok: false; message: string };

/**
 * What the link shows before anybody signs in.
 *
 * Deliberately thin: the child's name, the centre's name, and the last two
 * digits of the number the code will go to. Anyone holding the URL sees this,
 * so it carries only what a parent needs to recognise that the link is for
 * them — and nothing about the child's work.
 */
export async function previewInvitation(
  token: string,
  now = new Date(),
): Promise<InvitePreview> {
  const rows = await withTenantless(hashToken(token), now);
  if (!rows) {
    return {
      ok: false,
      message: "This link is not valid any more. Ask for a new one.",
    };
  }
  return rows;
}

/**
 * The pre-tenant read.
 *
 * An invitation is resolved before anybody has a session, which is the same
 * ordering problem sign-in has — so it is answered the same way: a narrow,
 * fixed-shape read, and nothing else escapes it.
 */
async function withTenantless(
  tokenHash: Buffer,
  now: Date,
): Promise<InvitePreview | null> {
  const row = await invitationForAcceptance(tokenHash, now);
  if (!row) return null;

  return {
    ok: true,
    studentName: row.student_name,
    organizationName: row.organization_name,
    relationship: row.relationship ?? "GUARDIAN",
    phoneHint: `•••••• ${row.phone.slice(-4)}`,
  };
}

export type AcceptResult =
  | { ok: true; linkId: string; studentUserId: string; organizationId: string }
  | { ok: false; message: string };

/**
 * Turn a verified phone into consent.
 *
 * Called only after the OTP has been verified for the SAME number the
 * invitation was addressed to — checked here rather than trusted from the
 * caller, because "I verified a phone" and "I verified the right phone" are
 * different claims and only one of them is consent.
 */
export async function acceptInvitation(
  token: string,
  verifiedPhone: string,
  parentUserId: string,
  now = new Date(),
): Promise<AcceptResult> {
  const invitation = await invitationForAcceptance(hashToken(token), now);
  if (!invitation) {
    return {
      ok: false,
      message: "This link is not valid any more. Ask for a new one.",
    };
  }

  const phone = verifiedPhone.replace(/\D/g, "").slice(-10);
  if (phone !== invitation.phone) {
    // One message. Saying "that is not the invited number" would turn the link
    // into a way of testing which numbers are attached to which children.
    return {
      ok: false,
      message: "This link is not valid any more. Ask for a new one.",
    };
  }

  const organizationId = invitation.organization_id;

  const outcome = await withTenant<AcceptOutcome | null>(
    organizationId,
    async (tx) => {
      const row = await tx.invitation.findFirst({
        where: { tokenHash: new Uint8Array(hashToken(token)) },
        select: { id: true, createdAt: true },
      });
      if (!row) return null;

      const existing = await tx.parentStudentLink.findFirst({
        where: {
          parentUserId,
          studentUserId: invitation.student_user_id,
        },
      });

      // An invitation issued BEFORE the revocation cannot undo it. Revoking
      // already cancels every outstanding invitation to that parent, so this
      // is the second line rather than the only one — but it is the line that
      // still holds for an invitation somebody forgets to cancel next year.
      if (existing?.revokedAt && row.createdAt <= existing.revokedAt) {
        return null;
      }

      // Claimed atomically, in the same transaction as the consent. Two taps
      // racing on one link produce one acceptance; the loser matches no row.
      const claimed = await tx.invitation.updateMany({
        where: { id: row.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: now },
      });
      if (claimed.count !== 1) return null;

      if (existing && !existing.revokedAt) {
        if (existing.consentGrantedAt) {
          // Already consented. The ORIGINAL consent stamp stays: re-stamping
          // it would move "since when could they see this" to today.
          return { linkId: existing.id, restoredFrom: null };
        }
        await tx.parentStudentLink.update({
          where: { id: existing.id },
          data: { consentGrantedAt: now, consentGrantedBy: parentUserId },
        });
        return { linkId: existing.id, restoredFrom: null };
      }

      if (existing) {
        // A NEW invitation, sent by the school after the revocation, restores
        // access. The link row is unique per parent and child, so the previous
        // period is carried into the append-only audit log — consent, who gave
        // it, when it was revoked and by whom — in the same breath as the row
        // changes. "Who could see this child's results, and until when" stays
        // answerable for every period, not only the current one.
        //
        // Written INSIDE this transaction rather than after it, unlike the
        // other audit rows here: this one is the only remaining copy of the
        // revocation stamp, so the row must not change without it.
        const restoredFrom = {
          consentGrantedAt: existing.consentGrantedAt?.toISOString() ?? null,
          consentGrantedBy: existing.consentGrantedBy,
          revokedAt: existing.revokedAt!.toISOString(),
          revokedBy: existing.revokedBy,
        };
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: parentUserId,
            actorRole: "PARENT",
            action: "parent.consent_regranted",
            entityType: "parent_student_link",
            entityId: existing.id,
            before: restoredFrom,
            after: {
              studentUserId: invitation.student_user_id,
              invitationId: row.id,
              consentGrantedAt: now.toISOString(),
            },
          },
        });
        await tx.parentStudentLink.update({
          where: { id: existing.id },
          data: {
            consentGrantedAt: now,
            consentGrantedBy: parentUserId,
            revokedAt: null,
            revokedBy: null,
          },
        });
        return { linkId: existing.id, restoredFrom };
      }

      const created = await tx.parentStudentLink.create({
        data: {
          organizationId,
          parentUserId,
          studentUserId: invitation.student_user_id,
          relationship: (invitation.relationship ?? "GUARDIAN") as Relationship,
          // Stamped here, attributed to the person who actually consented — the
          // parent holding the phone, not the teacher who sent the link.
          consentGrantedAt: now,
          consentGrantedBy: parentUserId,
        },
      });
      return { linkId: created.id, restoredFrom: null };
    },
  );

  if (!outcome) {
    return {
      ok: false,
      message: "This link is not valid any more. Ask for a new one.",
    };
  }

  if (!outcome.restoredFrom) {
    await writeAudit({
      organizationId,
      actorUserId: parentUserId,
      actorRole: "PARENT",
      action: "parent.consent_granted",
      entityType: "parent_student_link",
      entityId: outcome.linkId,
      after: { studentUserId: invitation.student_user_id },
    });
  }

  return {
    ok: true,
    linkId: outcome.linkId,
    studentUserId: invitation.student_user_id,
    organizationId,
  };
}

type AcceptOutcome = {
  linkId: string;
  /** The revoked period this acceptance ended, kept for the audit row. */
  restoredFrom: {
    consentGrantedAt: string | null;
    consentGrantedBy: string | null;
    revokedAt: string;
    revokedBy: string | null;
  } | null;
};

export type LinkRow = {
  /** Null for an invitation nobody has accepted — there is no link row yet. */
  id: string | null;
  invitationId: string | null;
  parentUserId: string | null;
  /** The masked number for a pending invite; the name once they have accepted. */
  parentName: string;
  relationship: string;
  consentGrantedAt: Date | null;
  revokedAt: Date | null;
  status: "INVITED" | "ACTIVE" | "REVOKED" | "EXPIRED";
};

/**
 * Who can see this student, for the teacher who is responsible for them.
 *
 * Includes invitations nobody has accepted yet. Without them a teacher who
 * sends a link sees an empty list, cannot tell whether they already invited
 * somebody, and sends a second — which is how a child ends up with two live
 * links nobody meant to create.
 */
export async function linksForStudent(
  organizationId: string,
  studentUserId: string,
  now = new Date(),
): Promise<LinkRow[]> {
  if (!isUuid(studentUserId)) return [];
  return withTenant(organizationId, async (tx) => {
    const links = await tx.parentStudentLink.findMany({
      where: { studentUserId },
      orderBy: { createdAt: "asc" },
    });
    // No early return on an empty list: the pending invitations below are the
    // whole reason a teacher who has just invited somebody sees anything at
    // all, and returning early skipped exactly that case.
    const users = await tx.user.findMany({
      where: { id: { in: links.map((link) => link.parentUserId) } },
      select: { id: true, fullName: true },
    });
    const nameById = new Map(users.map((user) => [user.id, user.fullName]));

    const accepted: LinkRow[] = links.map((link) => ({
      id: link.id,
      invitationId: null,
      parentUserId: link.parentUserId,
      parentName: nameById.get(link.parentUserId) ?? "A parent",
      relationship: link.relationship,
      consentGrantedAt: link.consentGrantedAt,
      revokedAt: link.revokedAt,
      status: link.revokedAt
        ? ("REVOKED" as const)
        : link.consentGrantedAt
          ? ("ACTIVE" as const)
          : ("INVITED" as const),
    }));

    return [...accepted, ...(await pendingInvitations(tx, studentUserId, now))];
  });
}

/**
 * Invitations sent and not yet accepted.
 *
 * The number is masked here as it is on the invitation page: a teacher who
 * invited a parent needs to recognise which number they used, and a class list
 * on a shared screen does not need a guardian's phone number on it.
 */
async function pendingInvitations(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  studentUserId: string,
  now: Date,
): Promise<LinkRow[]> {
  const invitations = await tx.invitation.findMany({
    where: {
      studentUserId,
      role: "PARENT",
      acceptedAt: null,
      revokedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });

  return invitations.map((invitation) => ({
    id: null,
    invitationId: invitation.id,
    parentUserId: null,
    parentName: `•••••• ${(invitation.phone ?? "").slice(-4)}`,
    relationship: invitation.relationship ?? "GUARDIAN",
    consentGrantedAt: null,
    revokedAt: null,
    status: invitation.expiresAt <= now ? ("EXPIRED" as const) : ("INVITED" as const),
  }));
}

export type RevokeResult = { ok: true } | { ok: false; message: string };

export async function revokeLink(
  actor: Actor,
  linkId: string,
  now = new Date(),
): Promise<RevokeResult> {
  const outcome = await withTenant<RevokeResult>(
    actor.organizationId,
    async (tx) => {
      if (!isUuid(linkId)) return { ok: false, message: "We could not find that." };
      const link = await tx.parentStudentLink.findFirst({ where: { id: linkId } });
      if (!link) return { ok: false, message: "We could not find that." };
      if (link.revokedAt) {
        // Already revoked. The FIRST stamp is the one that says when access
        // ended; a second press must not move it.
        return { ok: true };
      }

      // A stamp, never a delete. The history of who could see a child's
      // results is exactly what gets asked for after something goes wrong.
      await tx.parentStudentLink.update({
        where: { id: linkId },
        data: { revokedAt: now, revokedBy: actor.userId },
      });

      // And every outstanding invitation to that parent about that child goes
      // with it. Otherwise a second, unaccepted link sitting in the parent's
      // messages is a way back in that the teacher who pressed Revoke cannot
      // see and did not mean to leave open.
      const parent = await tx.user.findFirst({
        where: { id: link.parentUserId },
        select: { phone: true },
      });
      if (parent?.phone) {
        await tx.invitation.updateMany({
          where: {
            role: "PARENT",
            studentUserId: link.studentUserId,
            phone: parent.phone,
            acceptedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
      }
      return { ok: true };
    },
  );

  if (outcome.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "parent.access_revoked",
      entityType: "parent_student_link",
      entityId: linkId,
    });
  }

  return outcome;
}

/**
 * Cancel an invitation nobody has accepted yet.
 *
 * Also a stamp. A teacher who typed the wrong number needs to be able to stop
 * that link working before somebody else's phone opens it.
 */
export async function cancelParentInvitation(
  actor: Actor,
  studentUserId: string,
  invitationId: string,
  now = new Date(),
): Promise<RevokeResult> {
  if (!isUuid(studentUserId) || !isUuid(invitationId)) {
    return { ok: false, message: "We could not find that." };
  }
  const outcome = await withTenant<RevokeResult>(
    actor.organizationId,
    async (tx) => {
      const cancelled = await tx.invitation.updateMany({
        where: {
          id: invitationId,
          studentUserId,
          role: "PARENT",
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      return cancelled.count === 1
        ? { ok: true }
        : { ok: false, message: "We could not find that invitation." };
    },
  );

  if (outcome.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "parent.invite_cancelled",
      entityType: "invitation",
      entityId: invitationId,
    });
  }
  return outcome;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id is a row that does not exist — never a 500 from Postgres. */
function isUuid(value: string): boolean {
  return UUID.test(value);
}

export type AcceptWithCodeResult =
  | {
      ok: true;
      token: string;
      expiresAt: Date;
      organizationId: string;
      studentUserId: string;
    }
  | { ok: false; message: string };

/**
 * The whole acceptance, in one call: verify, account, consent, session.
 *
 * ---------------------------------------------------------------------------
 * Why it is one call
 * ---------------------------------------------------------------------------
 * Splitting it would leave states nobody wants to own — a verified phone with
 * no account, an account with no consent, a consent with no session. Each is a
 * row somebody has to clean up, and one of them is a parent who has proved who
 * they are and cannot get in.
 *
 * ---------------------------------------------------------------------------
 * Consent is stamped to the person who gave it
 * ---------------------------------------------------------------------------
 * Not to the teacher who sent the link. The teacher asked; the parent holding
 * the phone agreed, and that distinction is the whole of what "explicit
 * recorded consent" means when somebody asks later.
 */
export async function acceptWithCode(
  token: string,
  rawPhone: string,
  code: string,
  meta: { fullName?: string; userAgent?: string; ip?: string } = {},
  now = new Date(),
): Promise<AcceptWithCodeResult> {
  const phone = rawPhone.replace(/\D/g, "").slice(-10);

  const invitation = await invitationForAcceptance(hashToken(token), now);
  // Resolved BEFORE the code is consumed, so a bad link does not burn a code
  // the parent then has to wait out.
  if (!invitation || invitation.phone !== phone) {
    return {
      ok: false,
      message: "This link is not valid any more. Ask for a new one.",
    };
  }

  const verified = await verifyCodeOnly(phone, hashCode(phone, code));
  if (!verified) {
    // One message for wrong, expired, used and locked-out — distinguishing
    // them tells somebody holding a stolen link which it was.
    return { ok: false, message: "That code did not work. Ask for a new one." };
  }

  const organizationId = invitation.organization_id;
  const existing = await findUserForAuth(phone);

  const parentUserId = existing?.id ?? randomUUID();

  await withTenant(organizationId, async (tx) => {
    if (!existing) {
      // createMany with an id generated here, not create(): Postgres applies
      // the SELECT policy to INSERT ... RETURNING, and this user has no
      // membership to be visible through yet. The roster learned this first.
      await tx.user.createMany({
        data: [
          {
            id: parentUserId,
            fullName: meta.fullName?.trim() || `Parent of ${invitation.student_name}`,
            phone,
            status: "ACTIVE",
          },
        ],
      });
    }

    const membership = await tx.membership.findFirst({
      where: { userId: parentUserId, role: "PARENT" },
    });
    if (!membership) {
      await tx.membership.createMany({
        data: [
          {
            id: randomUUID(),
            organizationId,
            userId: parentUserId,
            role: "PARENT",
            status: "ACTIVE",
            joinedAt: now,
          },
        ],
      });
    }
  });

  const accepted = await acceptInvitation(token, phone, parentUserId, now);
  if (!accepted.ok) return accepted;

  const session = createSessionToken();
  const expiresAt = sessionExpiry("PARENT");

  await withTenant(organizationId, async (tx) => {
    const membership = await tx.membership.findFirstOrThrow({
      where: { userId: parentUserId, role: "PARENT" },
    });
    await tx.session.create({
      data: {
        userId: parentUserId,
        organizationId,
        membershipId: membership.id,
        tokenHash: new Uint8Array(session.hash),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expiresAt,
      },
    });
  });

  return {
    ok: true,
    token: session.raw,
    expiresAt,
    organizationId,
    studentUserId: accepted.studentUserId,
  };
}
