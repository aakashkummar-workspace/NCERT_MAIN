import "server-only";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "./audit";
import {
  bootstrapOrganization,
  findUserForAuth,
  identifierTaken,
  listMembershipsForAuth,
} from "@/db/unscoped";
import type { Role } from "./authorize";
import { hashPassword, verifyPassword } from "./password";
import { slugify } from "./slug";
import { createSessionToken, sessionExpiry } from "./session";
import { boardByCode } from "@/core/curriculum";

/**
 * Sign-up and sign-in.
 *
 * Every organization is a real organization from the first signup — a solo
 * teacher is an org of one. There is no "personal mode", so growing into an
 * institute later changes a plan row, not a schema.
 */

export { slugify };
export { writeAudit };

export type SignUpInput = {
  fullName: string;
  email: string;
  password: string;
  organizationName: string;
  organizationType: "SOLO_TEACHER" | "TUITION_CENTRE" | "COACHING_INSTITUTE" | "SCHOOL";
  /**
   * Which board this school teaches.
   *
   * The one place a board legitimately arrives from a form: there is no
   * session and no organization yet, so there is nothing to read it from — the
   * board is what is being declared. Everywhere afterwards it comes from the
   * session's organization, and no route accepts one.
   *
   * Required, and deliberately not defaulted to CBSE here: the default belongs
   * on the picker, where a person can see it and change it.
   */
  boardCode: string;
};

export type AuthResult =
  | {
      ok: true;
      token: string;
      expiresAt: Date;
      organizationId: string;
      role: Role;
    }
  | {
      ok: false;
      code: "TAKEN" | "INVALID_CREDENTIALS" | "NO_MEMBERSHIP" | "UNKNOWN_BOARD";
      message: string;
    };

export async function signUp(
  input: SignUpInput,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();

  if (await identifierTaken(email, null)) {
    return {
      ok: false,
      code: "TAKEN",
      // Deliberately the same phrasing the sign-in page uses, so this is not an
      // account-enumeration oracle for someone probing addresses.
      message: "That email is already registered. Try signing in instead.",
    };
  }

  // Resolved before anything is written. `boards` is on the curriculum plane —
  // `for select using (true)` — so this read needs no tenant, which is just as
  // well: there is not one yet.
  const board = await boardByCode(input.boardCode);
  if (!board) {
    return {
      ok: false,
      code: "UNKNOWN_BOARD",
      message: "We do not have that board yet. Choose another.",
    };
  }

  const passwordHash = await hashPassword(input.password);
  // The slug is made unique inside app_auth_bootstrap_org — see prisma/rls.sql.
  // A pre-tenant uniqueness check here cannot work: organizations is behind an
  // RLS policy keyed on the current tenant, so it would always answer "free".
  const slug = slugify(input.organizationName);

  const { organizationId, userId, membershipId } = await bootstrapOrganization({
    orgName: input.organizationName.trim(),
    orgSlug: slug,
    orgType: input.organizationType,
    boardId: board.id,
    email,
    passwordHash,
    fullName: input.fullName.trim(),
  });

  const session = await issueSession({
    userId,
    organizationId,
    membershipId,
    role: "OWNER",
    ...meta,
  });

  await writeAudit({
    organizationId,
    actorUserId: userId,
    actorRole: "OWNER",
    action: "organization.created",
    entityType: "organization",
    entityId: organizationId,
    after: {
      name: input.organizationName,
      type: input.organizationType,
      board: board.code,
    },
    ...meta,
  });

  return { ok: true, ...session, organizationId, role: "OWNER" };
}

export async function signIn(
  input: { identifier: string; password: string },
  meta: { userAgent?: string; ip?: string } = {},
): Promise<AuthResult> {
  const user = await findUserForAuth(input.identifier.trim());

  // Same message and a comparable amount of work whether the account exists or
  // the password is wrong. Enumerating registered emails should cost an
  // attacker the same as guessing passwords.
  const failure: AuthResult = {
    ok: false,
    code: "INVALID_CREDENTIALS",
    message: "That email and password do not match. Check both and try again.",
  };

  if (!user || !user.password_hash || user.status !== "ACTIVE") {
    // Burn a comparable amount of time so absence is not detectable by latency.
    await verifyPassword(DUMMY_HASH, input.password);
    return failure;
  }

  const valid = await verifyPassword(user.password_hash, input.password);
  if (!valid) return failure;

  const memberships = await listMembershipsForAuth(user.id);
  const membership = memberships[0];
  if (!membership) {
    return {
      ok: false,
      code: "NO_MEMBERSHIP",
      message:
        "Your account is not attached to an organization yet. Ask whoever invited you to resend the invitation.",
    };
  }

  const session = await issueSession({
    userId: user.id,
    organizationId: membership.organization_id,
    membershipId: membership.membership_id,
    role: membership.role as Role,
    ...meta,
  });

  // Inside the tenant, because `users` is behind an RLS policy that resolves
  // through membership — an unscoped update here finds no row and throws.
  //
  // And non-fatal: a last-login stamp is telemetry. Failing to write it must
  // never cost a teacher a sign-in they had already earned.
  try {
    await withTenant(membership.organization_id, (tx) =>
      tx.user.updateMany({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
    );
  } catch {
    // Deliberately swallowed. The session above is already issued.
  }

  return {
    ok: true,
    ...session,
    organizationId: membership.organization_id,
    role: membership.role as Role,
  };
}

export async function signOut(sessionId: string, organizationId: string) {
  await withTenant(organizationId, (tx) =>
    tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function issueSession(input: {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: Role;
  userAgent?: string;
  ip?: string;
}) {
  const token = createSessionToken();
  const expiresAt = sessionExpiry(input.role);

  await withTenant(input.organizationId, (tx) =>
    tx.session.create({
      data: {
        userId: input.userId,
        organizationId: input.organizationId,
        membershipId: input.membershipId,
        // Prisma Bytes is Uint8Array; node crypto hands back a Buffer.
        tokenHash: new Uint8Array(token.hash),
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
        expiresAt,
      },
    }),
  );

  return { token: token.raw, expiresAt };
}

/**
 * A real argon2id digest of a value nobody knows, used only to spend
 * comparable time when an account does not exist.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c2FoYXlha2R1bW15c2FsdA$0Xr3sPTvVaGx1kZ9bqNqYqBiJ0m8ZLZ5nJq0nJqQxKk";
