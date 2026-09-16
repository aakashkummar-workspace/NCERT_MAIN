import { prisma } from "./client";

/**
 * The pre-tenant seam — and the only one.
 *
 * Sign-in has a genuine ordering problem: you cannot scope a lookup by an
 * organization the caller has not yet proved membership of. The session token
 * is what *tells* us the tenant, so resolving it cannot already be inside a
 * tenant.
 *
 * Rather than weakening the RLS policies for everything, those reads are
 * SECURITY DEFINER functions in prisma/rls.sql with a fixed, narrow shape: an
 * exact identifier in, at most one row of auth columns out. They cannot
 * enumerate, cannot filter and cannot project anything else.
 *
 * This module is the only place allowed to call them. Nothing here returns
 * anything a caller could use to read another tenant's data — a user id, a role
 * and an organization id, which is exactly what is needed to then open a
 * properly scoped withTenant() transaction.
 */

export type AuthUserRow = {
  id: string;
  password_hash: string | null;
  status: string;
  full_name: string;
};

export type AuthMembershipRow = {
  membership_id: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  role: string;
  status: string;
};

export type ResolvedSessionRow = {
  session_id: string;
  user_id: string;
  organization_id: string;
  membership_id: string;
  role: string;
  expires_at: Date;
  full_name: string;
  organization_name: string;
  platform_admin: boolean;
  /** The user's stored interface language, e.g. "en-IN" or "hi-IN". */
  locale: string | null;
};

/** Finds one user by exact email or phone. Returns null when absent. */
export async function findUserForAuth(
  identifier: string,
): Promise<AuthUserRow | null> {
  const rows = await prisma.$queryRaw<AuthUserRow[]>`
    select * from app_auth_find_user(${identifier})
  `;
  return rows[0] ?? null;
}

/** True when an email or phone is already registered. */
export async function identifierTaken(
  email: string | null,
  phone: string | null,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ app_auth_identifier_taken: boolean }[]>`
    select app_auth_identifier_taken(${email}, ${phone})
  `;
  return rows[0]?.app_auth_identifier_taken ?? false;
}

/** Active memberships for a user, across organizations. */
export async function listMembershipsForAuth(
  userId: string,
): Promise<AuthMembershipRow[]> {
  return prisma.$queryRaw<AuthMembershipRow[]>`
    select * from app_auth_list_memberships(${userId}::uuid)
  `;
}

/**
 * Resolves a session token hash to its principal. Returns null for an unknown,
 * revoked or expired token, or one whose user or membership is no longer
 * active — so revocation takes effect on the very next request.
 */
export async function resolveSession(
  tokenHash: Buffer,
): Promise<ResolvedSessionRow | null> {
  const rows = await prisma.$queryRaw<ResolvedSessionRow[]>`
    select * from app_auth_resolve_session(${tokenHash})
  `;
  return rows[0] ?? null;
}

/**
 * Creates an organization, its first user and an OWNER membership in one
 * transaction. Signup is the one flow where none of the three exists yet, so
 * there is no tenant to scope it by.
 */
export async function bootstrapOrganization(input: {
  orgName: string;
  orgSlug: string;
  orgType: string;
  /**
   * The board this organization will teach. Required, because
   * `organizations.board_id` is NOT NULL and has no default — a signup that
   * forgot to name a board must fail here rather than quietly become a CBSE
   * school.
   */
  boardId: string;
  email: string;
  passwordHash: string;
  fullName: string;
}): Promise<{ organizationId: string; userId: string; membershipId: string }> {
  const rows = await prisma.$queryRaw<
    { organization_id: string; user_id: string; membership_id: string }[]
  >`
    select * from app_auth_bootstrap_org(
      ${input.orgName}, ${input.orgSlug}, ${input.orgType},
      ${input.boardId}::uuid,
      ${input.email}, ${input.passwordHash}, ${input.fullName}
    )
  `;
  const row = rows[0];
  if (!row) throw new Error("bootstrapOrganization returned no row");
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    membershipId: row.membership_id,
  };
}

export type InvitationRow = {
  organization_id: string;
  organization_name: string;
  student_user_id: string;
  student_name: string;
  relationship: string | null;
  phone: string;
};

/**
 * Resolve a parent invitation token, before any tenant is known.
 *
 * The fifth and last pre-tenant read. Same shape as the others: an exact hash
 * in, at most one narrow row out, no enumeration and no projection. It returns
 * nothing about the child's work — this answers an unauthenticated URL.
 */
export async function invitationForAcceptance(
  tokenHash: Buffer,
  now: Date,
): Promise<InvitationRow | null> {
  const rows = await prisma.$queryRaw<InvitationRow[]>`
    select * from app_auth_invitation(${tokenHash}, ${now})
  `;
  return rows[0] ?? null;
}

export type StaffInvitationRow = {
  invitation_id: string;
  organization_id: string;
  organization_name: string;
  email: string;
  role: string;
};

/**
 * Resolve a STAFF invitation token, before any tenant is known.
 *
 * A colleague opening `/join/<token>` has no session in the inviting
 * organization, and usually no account at all. Same shape as the parent read:
 * an exact hash in, at most one narrow row out, and only while the invitation
 * is unaccepted, unrevoked and unexpired — so a link works once.
 */
export async function staffInvitationForAcceptance(
  tokenHash: Buffer,
  now: Date,
): Promise<StaffInvitationRow | null> {
  const rows = await prisma.$queryRaw<StaffInvitationRow[]>`
    select * from app_auth_staff_invitation(${tokenHash}, ${now})
  `;
  return rows[0] ?? null;
}

export type PublicBrandingRow = {
  organization_name: string;
  display_name: string | null;
  short_name: string | null;
  tagline: string | null;
  logo_id: string | null;
  theme: unknown;
  website: string | null;
  hide_powered_by: boolean;
};

/**
 * A school's public face, for its branded sign-in page.
 *
 * An exact slug in, at most one row of what the page draws out — no
 * organization id, no official details. Null for an unknown slug AND for a
 * school whose plan does not include white labelling, which the caller must
 * not distinguish: "this school exists but has not paid" is not something a
 * stranger's URL should be able to find out.
 */
export async function publicBranding(slug: string): Promise<PublicBrandingRow | null> {
  const rows = await prisma.$queryRaw<PublicBrandingRow[]>`
    select * from app_public_branding(${slug})
  `;
  return rows[0] ?? null;
}

/** The current logo of a branded school, by slug and exact logo id. */
export async function publicLogo(
  slug: string,
  logoId: string,
): Promise<{ mime: string; bytes: Uint8Array } | null> {
  const rows = await prisma.$queryRaw<{ mime: string; bytes: Uint8Array }[]>`
    select * from app_public_logo(${slug}, ${logoId}::uuid)
  `;
  return rows[0] ?? null;
}

/**
 * Was that code right? — without requiring the account to exist yet.
 *
 * `app_auth_consume_code` answers "which user does this belong to", and returns
 * nothing when there is no user. That is right for a student, who is on a
 * roster before they ever sign in, and wrong for a parent, who has no account
 * until they accept. Same consume-and-count semantics either way.
 */
export async function verifyCodeOnly(
  phone: string,
  codeHash: Buffer,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ app_auth_verify_code: boolean }[]>`
    select app_auth_verify_code(${phone}, ${codeHash})
  `;
  return rows[0]?.app_auth_verify_code === true;
}

// ---------------------------------------------------------------------------
// The SMS ledger, before a tenant is known
// ---------------------------------------------------------------------------

/**
 * Record an SMS attempt.
 *
 * A student asking for a sign-in code has no tenant yet — the code is what will
 * eventually tell us which one — so the row belongs to nobody and the tenant
 * policy correctly refuses to let the app role write it. The same ordering
 * problem sign-in itself has, answered the same way: a narrow SECURITY DEFINER
 * function with a fixed shape, reachable only from this module.
 *
 * `organizationId` is passed through for the messages that DO have a tenant —
 * a parent invitation is sent from inside a school.
 */
export async function recordSmsAttempt(input: {
  id: string;
  organizationId: string | null;
  phone: string;
  template: string;
  provider: string | null;
}): Promise<void> {
  // `$executeRaw`, not `$queryRaw`: the function returns void, and Prisma
  // cannot deserialise a void column. This is a statement, not a question.
  await prisma.$executeRaw`
    select app_sms_record(
      ${input.id}::uuid,
      ${input.organizationId}::uuid,
      ${input.phone},
      ${input.template},
      ${input.provider}
    )
  `;
}

/** Close it out, whatever happened — including the sends that never happened. */
export async function closeSmsAttempt(input: {
  id: string;
  status: "SENT" | "FAILED" | "SKIPPED";
  providerMessageId?: string | null;
  costMicros?: number | null;
  error?: string | null;
}): Promise<void> {
  await prisma.$executeRaw`
    select app_sms_close(
      ${input.id}::uuid,
      ${input.status},
      ${input.providerMessageId ?? null},
      ${input.costMicros ?? null}::int,
      ${input.error ?? null}
    )
  `;
}

/**
 * How many messages actually went out today.
 *
 * A count and nothing else — no phone, no id, no row. It backs the daily
 * ceiling in `src/sms/gateway.ts`, which protects an SMS bill rather than a
 * person, and therefore has to be readable without a tenant.
 */
export async function smsSentToday(): Promise<number> {
  const rows = await prisma.$queryRaw<{ app_sms_sent_today: bigint }[]>`
    select app_sms_sent_today()
  `;
  return Number(rows[0]?.app_sms_sent_today ?? 0);
}
