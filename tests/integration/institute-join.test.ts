import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { cancelInvite, inviteStaff, INVITE_TTL_MS } from "@/core/institute/members";
import {
  acceptStaffInvitation,
  previewStaffInvitation,
} from "@/core/identity/staff-invitation";
import { signUp } from "@/core/identity/accounts";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

const PASSWORD = "a-long-enough-password";

function address() {
  return `join.${randomUUID().slice(0, 12)}@example.test`;
}

async function invite(world: World, role: "OWNER" | "ADMIN" | "TEACHER" = "TEACHER") {
  const email = address();
  const invited = await inviteStaff(teacherOf(world), { email, role });
  if (!invited.ok) throw new Error(invited.message);
  return { email, token: invited.token, invitationId: invited.invitationId };
}

async function membershipOf(world: World, email: string) {
  return withTenant(world.organizationId, async (tx) => {
    const user = await tx.user.findFirst({ where: { email } });
    if (!user) return null;
    return tx.membership.findFirst({ where: { userId: user.id } });
  });
}

describe("joining an institute from an invitation", () => {
  it("previews the organisation and role, and nothing else", async () => {
    const world = await makeWorld();
    const { email, token } = await invite(world, "ADMIN");

    const preview = await previewStaffInvitation(token);
    if (!preview.ok) throw new Error(preview.message);
    expect(preview.role).toBe("ADMIN");
    expect(preview.email).toBe(email);
    expect(preview.accountExists).toBe(false);
    expect(preview.organizationName).toBeTruthy();
  });

  it("creates the account, joins with the INVITED role, and signs them in", async () => {
    const world = await makeWorld();
    const { email, token, invitationId } = await invite(world, "TEACHER");

    const joined = await acceptStaffInvitation(token, {
      mode: "create",
      email,
      password: PASSWORD,
      fullName: "New Colleague",
    });
    if (!joined.ok) throw new Error(joined.message);
    expect(joined.organizationId).toBe(world.organizationId);
    expect(joined.role).toBe("TEACHER");
    expect(joined.token).toBeTruthy();

    const membership = await membershipOf(world, email);
    expect(membership?.role).toBe("TEACHER");
    expect(membership?.status).toBe("ACTIVE");

    const invitation = await withTenant(world.organizationId, (tx) =>
      tx.invitation.findFirstOrThrow({ where: { id: invitationId } }),
    );
    expect(invitation.acceptedAt).not.toBeNull();

    const audit = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.findFirst({
        where: { action: "member.joined", entityId: membership!.id },
      }),
    );
    expect(audit).not.toBeNull();
  });

  it("lets somebody with an account sign in to join", async () => {
    const world = await makeWorld();
    const email = address();
    // An account elsewhere — a teacher who runs their own solo workspace.
    const elsewhere = await signUp({
      fullName: "Existing Teacher",
      email,
      password: PASSWORD,
      organizationName: "Elsewhere",
      organizationType: "SOLO_TEACHER",
      boardCode: "CBSE",
    });
    expect(elsewhere.ok).toBe(true);

    const invited = await inviteStaff(teacherOf(world), { email, role: "ADMIN" });
    if (!invited.ok) throw new Error(invited.message);
    const preview = await previewStaffInvitation(invited.token);
    expect(preview.ok && preview.accountExists).toBe(true);

    const wrong = await acceptStaffInvitation(invited.token, {
      mode: "signin",
      email,
      password: "not-the-password",
    });
    expect(wrong.ok).toBe(false);

    const joined = await acceptStaffInvitation(invited.token, {
      mode: "signin",
      email,
      password: PASSWORD,
    });
    if (!joined.ok) throw new Error(joined.message);
    expect(joined.organizationId).toBe(world.organizationId);
    expect((await membershipOf(world, email))?.role).toBe("ADMIN");
  });

  it("works once", async () => {
    const world = await makeWorld();
    const { email, token } = await invite(world);

    const first = await acceptStaffInvitation(token, {
      mode: "create",
      email,
      password: PASSWORD,
      fullName: "Once Only",
    });
    expect(first.ok).toBe(true);

    expect((await previewStaffInvitation(token)).ok).toBe(false);
    const second = await acceptStaffInvitation(token, {
      mode: "signin",
      email,
      password: PASSWORD,
    });
    expect(second.ok).toBe(false);
  });

  it("refuses an expired invitation", async () => {
    const world = await makeWorld();
    const { email, token } = await invite(world);
    const later = new Date(Date.now() + INVITE_TTL_MS + 60_000);

    expect((await previewStaffInvitation(token, later)).ok).toBe(false);
    const joined = await acceptStaffInvitation(
      token,
      { mode: "create", email, password: PASSWORD, fullName: "Too Late" },
      {},
      later,
    );
    expect(joined.ok).toBe(false);
    expect(await membershipOf(world, email)).toBeNull();
  });

  it("refuses a cancelled invitation", async () => {
    const world = await makeWorld();
    const { email, token, invitationId } = await invite(world);
    expect((await cancelInvite(teacherOf(world), invitationId)).ok).toBe(true);

    const joined = await acceptStaffInvitation(token, {
      mode: "create",
      email,
      password: PASSWORD,
      fullName: "Cancelled",
    });
    expect(joined.ok).toBe(false);
    expect(await membershipOf(world, email)).toBeNull();
  });

  it("refuses an account for a different address than the one invited", async () => {
    const world = await makeWorld();
    const { token } = await invite(world);
    const other = address();

    const joined = await acceptStaffInvitation(token, {
      mode: "create",
      email: other,
      password: PASSWORD,
      fullName: "Forwarded To",
    });
    expect(joined.ok).toBe(false);
    expect(await membershipOf(world, other)).toBeNull();
  });

  it("refuses an OWNER invitation whose sender is no longer an owner", async () => {
    const world = await makeWorld();
    const { email, token } = await invite(world, "OWNER");

    // The owner who sent it is demoted before it is opened.
    await withTenant(world.organizationId, (tx) =>
      tx.membership.updateMany({
        where: { userId: world.teacherId },
        data: { role: "ADMIN" },
      }),
    );

    const joined = await acceptStaffInvitation(token, {
      mode: "create",
      email,
      password: PASSWORD,
      fullName: "Would Be Owner",
    });
    expect(joined.ok).toBe(false);
    if (!joined.ok) expect(joined.message).toMatch(/only an owner/i);
    expect(await membershipOf(world, email)).toBeNull();
  });
});
