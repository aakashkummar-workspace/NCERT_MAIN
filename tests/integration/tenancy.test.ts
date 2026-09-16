import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { withTenant, withoutTenant } from "@/db/tenant";

/**
 * The suite that must never be skipped.
 *
 * A cross-tenant leak — one school seeing another's students — ends the
 * company. Everything here runs as `sahayak_app`, which cannot bypass RLS;
 * tests/integration/setup.ts refuses to run otherwise.
 */

type Fixture = {
  orgId: string;
  userId: string;
  membershipId: string;
  email: string;
};

async function seedOrg(label: string): Promise<Fixture> {
  const email = `${label}-${randomUUID()}@example.test`;
  // The board is a column on the organization now, and the bootstrap takes it
  // as its fourth argument. Read, not hard-coded: a board id differs per
  // database, and this suite must not depend on which one it runs against.
  const boards = await prisma.$queryRaw<{ id: string }[]>`
    select id from boards where code = 'CBSE'
  `;
  const boardId = boards[0]!.id;
  const rows = await prisma.$queryRaw<
    { organization_id: string; user_id: string; membership_id: string }[]
  >`
    select * from app_auth_bootstrap_org(
      ${`Org ${label}`}, ${`org-${label}-${randomUUID().slice(0, 8)}`},
      'TUITION_CENTRE', ${boardId}::uuid, ${email}, 'not-a-real-hash', ${`Owner ${label}`}
    )
  `;
  const row = rows[0]!;
  return {
    orgId: row.organization_id,
    userId: row.user_id,
    membershipId: row.membership_id,
    email,
  };
}

let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  A = await seedOrg("alpha");
  B = await seedOrg("bravo");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("tenant isolation", () => {
  it("sees only its own memberships", async () => {
    const rows = await withTenant(A.orgId, (tx) => tx.membership.findMany());
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.organizationId).toBe(A.orgId);
  });

  it("cannot read the other organization's membership even by exact id", async () => {
    // The dangerous case: the caller already knows the id. RLS must still
    // refuse, because "unguessable" is not an access control.
    const found = await withTenant(A.orgId, (tx) =>
      tx.membership.findUnique({ where: { id: B.membershipId } }),
    );
    expect(found).toBeNull();
  });

  it("cannot read the other organization's row", async () => {
    const found = await withTenant(A.orgId, (tx) =>
      tx.organization.findUnique({ where: { id: B.orgId } }),
    );
    expect(found).toBeNull();
  });

  it("cannot read the other organization's user", async () => {
    const found = await withTenant(A.orgId, (tx) =>
      tx.user.findUnique({ where: { id: B.userId } }),
    );
    expect(found).toBeNull();
  });

  it("counts only its own rows", async () => {
    const [countA, countB] = await Promise.all([
      withTenant(A.orgId, (tx) => tx.membership.count()),
      withTenant(B.orgId, (tx) => tx.membership.count()),
    ]);
    // An aggregate is the classic way a leak hides: no row is returned, but the
    // number still counts the other tenant's data.
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  it("cannot update another organization's row", async () => {
    const result = await withTenant(A.orgId, (tx) =>
      tx.membership.updateMany({
        where: { id: B.membershipId },
        data: { role: "ADMIN" },
      }),
    );
    expect(result.count).toBe(0);

    const untouched = await withTenant(B.orgId, (tx) =>
      tx.membership.findUnique({ where: { id: B.membershipId } }),
    );
    expect(untouched?.role).toBe("OWNER");
  });

  it("cannot delete another organization's row", async () => {
    const result = await withTenant(A.orgId, (tx) =>
      tx.membership.deleteMany({ where: { id: B.membershipId } }),
    );
    expect(result.count).toBe(0);
  });

  it("refuses an insert carrying another organization's id (WITH CHECK)", async () => {
    await expect(
      withTenant(A.orgId, (tx) =>
        tx.auditLog.create({
          data: {
            organizationId: B.orgId,
            action: "forged.write",
            entityType: "organization",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("denies everything when no tenant context is set", async () => {
    // Deny by default: an absent context must mean no rows, never all rows.
    const [orgs, members, sessions] = await withoutTenant(async (tx) => [
      await tx.organization.count(),
      await tx.membership.count(),
      await tx.session.count(),
    ]);
    expect(orgs).toBe(0);
    expect(members).toBe(0);
    expect(sessions).toBe(0);
  });
});

describe("tenant context is transaction-local", () => {
  it("does not leak between sequential transactions on the same connection", async () => {
    // The failure this guards against is invisible in a single-tenant test: set
    // the context session-wide once, and every later request on that pooled
    // connection reads the first tenant's rows with no error and no log line.
    await withTenant(A.orgId, (tx) => tx.membership.count());

    const leaked = await withoutTenant((tx) => tx.membership.count());
    expect(leaked).toBe(0);

    const stillScoped = await withTenant(B.orgId, (tx) =>
      tx.membership.findMany(),
    );
    for (const row of stillScoped) expect(row.organizationId).toBe(B.orgId);
  });

  it("rejects an organizationId that is not a UUID", async () => {
    // This value is interpolated into set_config; a non-UUID means a caller has
    // passed something it should not have — quite possibly a request body.
    await expect(
      withTenant("'; drop table users; --", async () => null),
    ).rejects.toThrow(/not a UUID/);
  });
});

describe("audit log is append-only", () => {
  it("accepts an insert", async () => {
    const entry = await withTenant(A.orgId, (tx) =>
      tx.auditLog.create({
        data: {
          organizationId: A.orgId,
          action: "test.written",
          entityType: "organization",
          entityId: A.orgId,
        },
      }),
    );
    expect(entry.id).toBeTruthy();
  });

  it("refuses an update", async () => {
    const entry = await withTenant(A.orgId, (tx) =>
      tx.auditLog.create({
        data: {
          organizationId: A.orgId,
          action: "test.immutable",
          entityType: "organization",
        },
      }),
    );

    await expect(
      withTenant(A.orgId, (tx) =>
        tx.auditLog.update({
          where: { id: entry.id },
          data: { action: "rewritten" },
        }),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses a delete", async () => {
    const entry = await withTenant(A.orgId, (tx) =>
      tx.auditLog.create({
        data: {
          organizationId: A.orgId,
          action: "test.undeletable",
          entityType: "organization",
        },
      }),
    );

    await expect(
      withTenant(A.orgId, (tx) =>
        tx.auditLog.delete({ where: { id: entry.id } }),
      ),
    ).rejects.toThrow(/append-only/);
  });
});
