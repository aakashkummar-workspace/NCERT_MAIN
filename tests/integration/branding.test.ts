import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  editorState,
  effectiveBranding,
  readLogo,
  saveBranding,
  uploadLogo,
} from "@/core/branding";
import { publicBrand, publicLogoFor } from "@/core/branding/public";
import { can } from "@/core/billing/entitlements";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { makeWorld, teacherOf, type World } from "./support/world";

afterAll(async () => {
  await prisma.$disconnect();
});

// The world's teacher is the signup OWNER, which is who edits branding.
const ownerOf = (world: World) => teacherOf(world);

async function subscribe(
  organizationId: string,
  planCode: string,
  status: "ACTIVE" | "TRIALING" | "CANCELLED" | "EXPIRED" = "ACTIVE",
) {
  const plan = await prisma.plan.findFirstOrThrow({ where: { code: planCode } });
  await withTenant(organizationId, async (tx) => {
    const existing = await tx.subscription.findFirst({ where: { organizationId } });
    if (existing) {
      await tx.subscription.update({ where: { id: existing.id }, data: { planId: plan.id, status } });
      return;
    }
    await tx.subscription.createMany({
      data: [{ id: randomUUID(), organizationId, planId: plan.id, status }],
    });
  });
}

async function slugOf(organizationId: string) {
  const org = await withTenant(organizationId, (tx) =>
    tx.organization.findFirstOrThrow({ where: { id: organizationId }, select: { slug: true } }),
  );
  return org.slug;
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

describe("branding is a plan capability", () => {
  it("is refused on the free shape, and nothing renders", async () => {
    const world = await makeWorld();
    const result = await saveBranding(ownerOf(world), { details: { displayName: "Nope" }, theme: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-entitled");
    expect(await effectiveBranding(world.organizationId)).toBeNull();
  });

  it("renders on a plan that includes it", async () => {
    const world = await makeWorld();
    await subscribe(world.organizationId, "institute");
    const saved = await saveBranding(ownerOf(world), {
      details: { displayName: "St. Test's School", tagline: "Learning together" },
      theme: { brand: "#1f4e9c" },
    });
    expect(saved.ok).toBe(true);

    const brand = await effectiveBranding(world.organizationId);
    expect(brand?.name).toBe("St. Test's School");
    expect(brand?.shortName).toBe("T");
    expect(brand?.css).toContain("--primary-600:#1f4e9c;");
  });

  it("stops rendering when the plan lapses, and keeps what was typed", async () => {
    const world = await makeWorld();
    await subscribe(world.organizationId, "institute");
    await saveBranding(ownerOf(world), { details: { address: "1 School Road" }, theme: {} });

    await subscribe(world.organizationId, "institute", "CANCELLED");
    expect(await effectiveBranding(world.organizationId)).toBeNull();

    // A renewal brings it back without anybody retyping the address.
    const state = await editorState(world.organizationId);
    expect(state?.entitled).toBe(false);
    expect(state?.details.address).toBe("1 School Road");
  });

  it("refuses an unreadable theme and writes nothing", async () => {
    const world = await makeWorld();
    await subscribe(world.organizationId, "institute");
    const result = await saveBranding(ownerOf(world), {
      details: { displayName: "Gold School" },
      theme: { brand: "#f5c400" },
    });
    expect(result.ok).toBe(false);
    const row = await withTenant(world.organizationId, (tx) =>
      tx.organizationBranding.findFirst({ where: { organizationId: world.organizationId } }),
    );
    expect(row).toBeNull();
  });

  it("renders a tampered stored theme as the default rather than trusting the row", async () => {
    const world = await makeWorld();
    await subscribe(world.organizationId, "institute");
    await saveBranding(ownerOf(world), { details: {}, theme: { brand: "#1f4e9c" } });
    // What a psql session or a migration could write.
    await withTenant(world.organizationId, (tx) =>
      tx.organizationBranding.update({
        where: { organizationId: world.organizationId },
        data: { theme: { brand: "#f5c400;}body{display:none" } },
      }),
    );
    const brand = await effectiveBranding(world.organizationId);
    expect(brand).not.toBeNull();
    expect(brand?.css).toBeNull();
  });
});

describe("the branded sign-in page", () => {
  it("returns only what the page draws", async () => {
    const world = await makeWorld();
    await subscribe(world.organizationId, "institute");
    await saveBranding(ownerOf(world), {
      details: {
        displayName: "Public School",
        principalName: "Mrs. Private",
        affiliationNumber: "1234567",
        address: "Not for strangers",
      },
      theme: {},
    });

    const brand = await publicBrand(await slugOf(world.organizationId));
    expect(brand?.name).toBe("Public School");
    const serialised = JSON.stringify(brand);
    expect(serialised).not.toContain("Mrs. Private");
    expect(serialised).not.toContain("1234567");
    expect(serialised).not.toContain("Not for strangers");
    expect(serialised).not.toContain(world.organizationId);
  });

  it("answers an unknown, an unbranded and an unentitled school identically", async () => {
    expect(await publicBrand(`no-such-school-${randomUUID().slice(0, 8)}`)).toBeNull();
    expect(await publicBrand("NOT A SLUG; drop table")).toBeNull();

    const unbranded = await makeWorld();
    await subscribe(unbranded.organizationId, "institute");
    expect(await publicBrand(await slugOf(unbranded.organizationId))).toBeNull();
  });

  /**
   * The SQL function states the entitlement rule a second time, because the
   * page has no tenant to ask `can()` with. This holds the two statements
   * against each other across every subscription state that matters.
   */
  it("agrees with can() about who is entitled", async () => {
    const world = await makeWorld();
    await subscribe(world.organizationId, "institute");
    await saveBranding(ownerOf(world), { details: { displayName: "Agreeing School" }, theme: {} });
    const slug = await slugOf(world.organizationId);

    const states: [string, "ACTIVE" | "TRIALING" | "CANCELLED" | "EXPIRED"][] = [
      ["institute", "ACTIVE"],
      ["institute", "TRIALING"],
      ["institute", "CANCELLED"],
      ["institute", "EXPIRED"],
      ["teacher_pro", "ACTIVE"],
    ];
    for (const [plan, status] of states) {
      await subscribe(world.organizationId, plan, status);
      const app = (await can(world.organizationId, "white_label")).allowed;
      const sql = (await publicBrand(slug)) !== null;
      expect({ plan, status, sql }).toEqual({ plan, status, sql: app });
    }
  });
});

describe("logos", () => {
  it("are readable inside the school and invisible outside it", async () => {
    const world = await makeWorld();
    const stranger = await makeWorld();
    await subscribe(world.organizationId, "institute");

    const uploaded = await uploadLogo(ownerOf(world), PNG);
    if (!uploaded.ok) throw new Error(uploaded.message);

    expect((await readLogo(world.organizationId, uploaded.logoId))?.mime).toBe("image/png");
    expect(await readLogo(stranger.organizationId, uploaded.logoId)).toBeNull();
  });

  it("serves only the CURRENT logo publicly, and keeps the old one for reports", async () => {
    const world = await makeWorld();
    await subscribe(world.organizationId, "institute");
    const slug = await slugOf(world.organizationId);

    const first = await uploadLogo(ownerOf(world), PNG);
    const second = await uploadLogo(ownerOf(world), PNG);
    if (!first.ok || !second.ok) throw new Error("upload failed");

    expect(await publicLogoFor(slug, second.logoId)).not.toBeNull();
    expect(await publicLogoFor(slug, first.logoId)).toBeNull();
    // Still drawable by a signed-in member, for the report stamped with it.
    expect(await readLogo(world.organizationId, first.logoId)).not.toBeNull();
  });

  it("refuses a file that is not an image, whatever it claims to be", async () => {
    const world = await makeWorld();
    await subscribe(world.organizationId, "institute");
    const result = await uploadLogo(ownerOf(world), new TextEncoder().encode("<svg onload=alert(1)>"));
    expect(result.ok).toBe(false);
  });
});
