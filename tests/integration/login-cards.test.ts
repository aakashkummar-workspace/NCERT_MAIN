import { afterAll, describe, expect, it } from "vitest";
import { hashToken } from "@/core/identity/session";
import {
  CARD_SESSION_MS,
  cardStatusForClass,
  issueCards,
  revokeCard,
  signInWithCard,
} from "@/core/identity/login-cards";
import { getClass } from "@/core/classes";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { resolveSession } from "@/db/unscoped";
import { makeWorld, teacherOf } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("printed sign-in cards", () => {
  it("signs the card's owner in, to their own school, for twelve hours", async () => {
    const world = await makeWorld();
    const issued = await issueCards(teacherOf(world), world.classId, { scope: "missing" });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const card = issued.cards.find((c) => c.studentUserId === world.studentId)!;
    expect(card.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const before = Date.now();
    const result = await signInWithCard(card.code.toLowerCase());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.role).toBe("STUDENT");
    expect(result.expiresAt.getTime() - before).toBeLessThanOrEqual(CARD_SESSION_MS + 5_000);

    const session = await resolveSession(hashToken(result.token));
    expect(session?.user_id).toBe(world.studentId);
    expect(session?.organization_id).toBe(world.organizationId);
  });

  it("never stores the code, only a hash and the last four characters", async () => {
    const world = await makeWorld();
    const issued = await issueCards(teacherOf(world), world.classId, { scope: "missing" });
    if (!issued.ok) throw new Error("no cards");
    const rows = await withTenant(world.organizationId, (tx) =>
      tx.loginCard.findMany({ where: { studentUserId: world.studentId } }),
    );
    const serialised = JSON.stringify(rows);
    const code = issued.cards.find((c) => c.studentUserId === world.studentId)!.code;
    expect(serialised).not.toContain(code);
    expect(serialised).not.toContain(code.replace(/-/g, ""));
    expect(rows[0]!.hint).toBe(code.slice(-4));
  });

  it("revokes the old card when a new one is printed", async () => {
    const world = await makeWorld();
    const first = await issueCards(teacherOf(world), world.classId, { scope: "missing" });
    if (!first.ok) throw new Error("no cards");
    const second = await issueCards(teacherOf(world), world.classId, {
      scope: "all",
      studentIds: [world.studentId],
    });
    if (!second.ok) throw new Error("no replacement");
    expect(second.cards).toHaveLength(1);

    const oldCode = first.cards.find((c) => c.studentUserId === world.studentId)!.code;
    expect((await signInWithCard(oldCode)).ok).toBe(false);
    expect((await signInWithCard(second.cards[0]!.code)).ok).toBe(true);

    // The other student's card was not touched.
    const otherCode = first.cards.find((c) => c.studentUserId === world.otherStudentId)!.code;
    expect((await signInWithCard(otherCode)).ok).toBe(true);
  });

  it("prints nothing for the missing scope once everyone holds one", async () => {
    const world = await makeWorld();
    await issueCards(teacherOf(world), world.classId, { scope: "missing" });
    const again = await issueCards(teacherOf(world), world.classId, { scope: "missing" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("NOTHING_TO_ISSUE");
  });

  it("stops working when the teacher stops it", async () => {
    const world = await makeWorld();
    const issued = await issueCards(teacherOf(world), world.classId, { scope: "missing" });
    if (!issued.ok) throw new Error("no cards");
    const code = issued.cards.find((c) => c.studentUserId === world.studentId)!.code;
    expect(await revokeCard(teacherOf(world), world.classId, world.studentId)).toBe(true);
    expect((await signInWithCard(code)).ok).toBe(false);
  });

  it("stops working when the student is removed from the school", async () => {
    const world = await makeWorld();
    const issued = await issueCards(teacherOf(world), world.classId, { scope: "missing" });
    if (!issued.ok) throw new Error("no cards");
    const code = issued.cards.find((c) => c.studentUserId === world.studentId)!.code;
    await withTenant(world.organizationId, (tx) =>
      tx.membership.updateMany({
        where: { userId: world.studentId },
        data: { status: "SUSPENDED" },
      }),
    );
    expect((await signInWithCard(code)).ok).toBe(false);
  });

  it("ignores a named student who is not in this class", async () => {
    const world = await makeWorld();
    const elsewhere = await makeWorld();
    const result = await issueCards(teacherOf(world), world.classId, {
      scope: "all",
      studentIds: [elsewhere.studentId],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a wrong code with the same sentence as a malformed one", async () => {
    const wrong = await signInWithCard("ZZZZ-ZZZZ-ZZZZ");
    const malformed = await signInWithCard("hello");
    expect(wrong.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    if (!wrong.ok && !malformed.ok) expect(wrong.message).toBe(malformed.message);
  });

  it("counts a card holder as somebody who can sign in", async () => {
    const world = await makeWorld();
    const status = await cardStatusForClass(world.organizationId, world.classId);
    expect(status?.every((row) => row.hint === null)).toBe(true);
    await issueCards(teacherOf(world), world.classId, { scope: "missing" });
    const klass = await getClass(world.organizationId, world.classId);
    expect(klass?.students.every((s) => s.hasCard && s.canSignIn)).toBe(true);
  });

  it("is invisible to another school", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    await issueCards(teacherOf(world), world.classId, { scope: "missing" });
    const seen = await withTenant(other.organizationId, (tx) =>
      tx.loginCard.count({ where: { organizationId: world.organizationId } }),
    );
    expect(seen).toBe(0);
  });
});
