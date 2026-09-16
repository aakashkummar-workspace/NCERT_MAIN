import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { whoCanSeeMyProgress } from "@/core/parent/read";
import { acceptInvitation, inviteParent, revokeLink } from "@/core/parent/link";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, studentOf, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

function freshPhone(): string {
  return `8${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

async function parentUser(world: World, phone: string) {
  const id = randomUUID();
  await withTenant(world.organizationId, async (tx) => {
    await tx.user.createMany({ data: [{ id, fullName: `Parent ${id.slice(0, 6)}`, phone, status: "ACTIVE" }] });
    await tx.membership.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: world.organizationId,
          userId: id,
          role: "PARENT",
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      ],
    });
  });
  return id;
}

async function link(world: World, studentUserId: string, relationship: "FATHER" | "MOTHER") {
  const phone = freshPhone();
  const parentId = await parentUser(world, phone);
  const invited = await inviteParent(teacherOf(world), { studentUserId, phone, relationship });
  if (!invited.ok) throw new Error(invited.message);
  const accepted = await acceptInvitation(invited.token, phone, parentId);
  if (!accepted.ok) throw new Error(accepted.message);
  return { phone, linkId: accepted.linkId };
}

describe("who can see my progress", () => {
  it("returns only the requesting student's own links", async () => {
    const world = await makeWorld();
    const mine = await link(world, world.studentId, "MOTHER");
    const theirs = await link(world, world.otherStudentId, "FATHER");
    const elsewhere = await makeWorld();
    await link(elsewhere, elsewhere.studentId, "FATHER");

    const viewers = await whoCanSeeMyProgress(studentOf(world));
    expect(viewers).toHaveLength(1);
    expect(viewers[0]).toMatchObject({ relationship: "MOTHER", status: "ACTIVE" });
    expect(viewers[0]!.phoneHint).toBe(`${mine.phone.slice(0, 2)}•••••${mine.phone.slice(-3)}`);

    const payload = JSON.stringify(viewers);
    expect(payload).not.toContain(mine.phone);
    expect(payload).not.toContain(theirs.phone);
    // No parent name and no ids travel either — the relationship is enough.
    expect(payload).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);

    const classmate = await whoCanSeeMyProgress({
      organizationId: world.organizationId,
      userId: world.otherStudentId,
    });
    expect(classmate).toEqual([expect.objectContaining({ relationship: "FATHER" })]);
  });

  it("lists a pending invitation masked, and drops a revoked link", async () => {
    const world = await makeWorld();
    const phone = freshPhone();
    const invited = await inviteParent(teacherOf(world), {
      studentUserId: world.studentId,
      phone,
      relationship: "GUARDIAN",
    });
    expect(invited.ok).toBe(true);

    const pending = await whoCanSeeMyProgress(studentOf(world));
    expect(pending).toEqual([
      expect.objectContaining({ relationship: "GUARDIAN", status: "INVITED" }),
    ]);
    expect(JSON.stringify(pending)).not.toContain(phone);

    const accepted = await link(world, world.studentId, "MOTHER");
    const revoked = await revokeLink(teacherOf(world), accepted.linkId);
    expect(revoked.ok).toBe(true);

    const after = await whoCanSeeMyProgress(studentOf(world));
    expect(after.some((row) => row.status === "ACTIVE")).toBe(false);
  });
});
