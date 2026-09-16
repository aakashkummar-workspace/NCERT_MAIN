import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { signIn, signOut, signUp } from "@/core/identity/accounts";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { hashToken } from "@/core/identity/session";
import { resolveSession } from "@/db/unscoped";

afterAll(async () => {
  await prisma.$disconnect();
});

function newEmail() {
  return `teacher-${randomUUID()}@example.test`;
}

const PASSWORD = "a-long-enough-password";

async function register(email = newEmail()) {
  const result = await signUp({
    fullName: "Priya Raman",
    email,
    password: PASSWORD,
    organizationName: "Raman Maths Centre",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!result.ok) throw new Error(`signUp failed: ${result.message}`);
  return { ...result, email };
}

describe("sign-up", () => {
  it("creates an organization, a user and an OWNER membership", async () => {
    const { organizationId, role } = await register();
    expect(role).toBe("OWNER");

    const members = await withTenant(organizationId, (tx) =>
      tx.membership.findMany(),
    );
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("OWNER");
    expect(members[0]?.status).toBe("ACTIVE");
  });

  it("issues a session that resolves to the new principal", async () => {
    const { token, organizationId } = await register();
    const resolved = await resolveSession(hashToken(token));
    expect(resolved?.organization_id).toBe(organizationId);
    expect(resolved?.role).toBe("OWNER");
  });

  it("writes an audit entry for the organization it created", async () => {
    const { organizationId } = await register();
    const entries = await withTenant(organizationId, (tx) =>
      tx.auditLog.findMany({ where: { action: "organization.created" } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.organizationId).toBe(organizationId);
  });

  it("refuses a duplicate email", async () => {
    const { email } = await register();
    const again = await signUp({
      fullName: "Someone Else",
      email,
      password: PASSWORD,
      organizationName: "Another Centre",
      organizationType: "SOLO_TEACHER",
      boardCode: "CBSE",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("TAKEN");
  });

  it("gives two organizations of the same name distinct slugs", async () => {
    const a = await register();
    const b = await register();
    const [orgA, orgB] = await Promise.all([
      withTenant(a.organizationId, (tx) =>
        tx.organization.findUniqueOrThrow({ where: { id: a.organizationId } }),
      ),
      withTenant(b.organizationId, (tx) =>
        tx.organization.findUniqueOrThrow({ where: { id: b.organizationId } }),
      ),
    ]);
    expect(orgA.slug).not.toBe(orgB.slug);
  });
});

describe("sign-in", () => {
  it("succeeds with the right password", async () => {
    // Regression: this failed with a 500 in the first build. `users` sits
    // behind an RLS policy that resolves through membership, and the
    // last-login stamp ran outside withTenant — so Postgres found no row and
    // Prisma threw, after the password had already been accepted. RLS caught a
    // real bug rather than the bug reaching production.
    const { email } = await register();
    const result = await signIn({ identifier: email, password: PASSWORD });
    expect(result.ok).toBe(true);
  });

  it("records the last login", async () => {
    const { email, organizationId } = await register();
    await signIn({ identifier: email, password: PASSWORD });
    const users = await withTenant(organizationId, (tx) => tx.user.findMany());
    expect(users[0]?.lastLoginAt).toBeInstanceOf(Date);
  });

  it("rejects a wrong password", async () => {
    const { email } = await register();
    const result = await signIn({ identifier: email, password: "wrong-password" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_CREDENTIALS");
  });

  it("gives an unknown account the same code and message as a wrong password", async () => {
    // Distinguishing them is an account-enumeration oracle.
    const { email } = await register();
    const wrong = await signIn({ identifier: email, password: "wrong-password" });
    const unknown = await signIn({
      identifier: "nobody@example.test",
      password: "wrong-password",
    });
    expect(unknown.ok).toBe(false);
    if (!wrong.ok && !unknown.ok) {
      expect(unknown.code).toBe(wrong.code);
      expect(unknown.message).toBe(wrong.message);
    }
  });

  it("is case-insensitive on email", async () => {
    const { email } = await register();
    const result = await signIn({
      identifier: email.toUpperCase(),
      password: PASSWORD,
    });
    expect(result.ok).toBe(true);
  });

  it("issues a distinct session each time", async () => {
    const { email } = await register();
    const a = await signIn({ identifier: email, password: PASSWORD });
    const b = await signIn({ identifier: email, password: PASSWORD });
    if (a.ok && b.ok) expect(a.token).not.toBe(b.token);
  });
});

describe("sign-out", () => {
  it("revokes the session immediately", async () => {
    const { email } = await register();
    const result = await signIn({ identifier: email, password: PASSWORD });
    if (!result.ok) throw new Error("sign-in failed");

    const before = await resolveSession(hashToken(result.token));
    expect(before).not.toBeNull();

    await signOut(before!.session_id, result.organizationId);

    // Revocation is checked on every request, so it takes effect on the next
    // one — not whenever a cache happens to expire.
    const after = await resolveSession(hashToken(result.token));
    expect(after).toBeNull();
  });

  it("leaves other sessions for the same user alone", async () => {
    const { email } = await register();
    const first = await signIn({ identifier: email, password: PASSWORD });
    const second = await signIn({ identifier: email, password: PASSWORD });
    if (!first.ok || !second.ok) throw new Error("sign-in failed");

    const firstResolved = await resolveSession(hashToken(first.token));
    await signOut(firstResolved!.session_id, first.organizationId);

    expect(await resolveSession(hashToken(first.token))).toBeNull();
    expect(await resolveSession(hashToken(second.token))).not.toBeNull();
  });
});

describe("session tokens", () => {
  it("stores only the hash — the raw token is not in the database", async () => {
    const { token, organizationId } = await register();
    const sessions = await withTenant(organizationId, (tx) =>
      tx.session.findMany(),
    );
    const stored = Buffer.from(sessions[0]!.tokenHash).toString("utf8");
    expect(stored).not.toContain(token);
    expect(sessions[0]!.tokenHash).toHaveLength(32);
  });

  it("refuses an unknown token", async () => {
    expect(await resolveSession(hashToken("not-a-real-token"))).toBeNull();
  });

  it("refuses an expired session", async () => {
    const { token, organizationId } = await register();
    const resolved = await resolveSession(hashToken(token));

    await withTenant(organizationId, (tx) =>
      tx.session.update({
        where: { id: resolved!.session_id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );

    expect(await resolveSession(hashToken(token))).toBeNull();
  });
});
