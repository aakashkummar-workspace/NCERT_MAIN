import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { signUp } from "@/core/identity/accounts";
import { can, currentPlan, recordUse, FREE_PLAN_CODE } from "@/core/billing/entitlements";
import { publicPlans } from "@/core/billing/plans";
import { runTask, setProvider } from "@/ai/gateway";
import { MockProvider } from "@/ai/mock";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";

afterAll(async () => {
  await prisma.$disconnect();
});

let mock: MockProvider;

beforeEach(() => {
  mock = new MockProvider();
  setProvider(mock);
});

afterEach(() => {
  setProvider(null);
});

async function makeOrg() {
  const result = await signUp({
    fullName: "Billing Teacher",
    email: `bill-${randomUUID()}@example.test`,
    password: "a-long-enough-password",
    organizationName: "Billing Org",
    organizationType: "TUITION_CENTRE",
    boardCode: "CBSE",
  });
  if (!result.ok) throw new Error("signUp failed");

  const membership = await withTenant(result.organizationId, (tx) =>
    tx.membership.findFirstOrThrow({ where: { role: "OWNER" } }),
  );
  return { organizationId: result.organizationId, userId: membership.userId };
}

const Answer = z.object({ answer: z.string() });

const task = (org: { organizationId: string; userId: string }) => ({
  organizationId: org.organizationId,
  userId: org.userId,
  feature: "QUESTION_GENERATION" as const,
  tier: "BALANCED" as const,
  system: "You write CBSE questions.",
  messages: [{ role: "user" as const, content: "Write one." }],
  schema: Answer,
  schemaName: "Answer",
  maxTokens: 500,
  input: { conceptId: "c-1" },
  safeFields: ["conceptId"] as const,
  entitlementKey: "ai_generations_per_month",
});

describe("plans are data", () => {
  it("has no price anywhere but the database", async () => {
    const plans = await publicPlans();
    expect(plans.length).toBeGreaterThan(0);
    // Paise, and an integer. Money in a float is how a bill stops adding up.
    for (const plan of plans) {
      expect(Number.isInteger(plan.pricePaise)).toBe(true);
    }
    expect(plans.find((plan) => plan.code === FREE_PLAN_CODE)).toBeTruthy();
  });

  it("keeps a negotiated plan off the pricing page", async () => {
    const plans = await publicPlans();
    // Institute is per student per month and negotiated. A number on a page
    // would be a number somebody quotes.
    expect(plans.some((plan) => plan.code === "institute")).toBe(false);
  });
});

describe("what an organisation may do", () => {
  it("falls back to free when there is no subscription", async () => {
    const org = await makeOrg();
    const plan = await currentPlan(org.organizationId);
    expect(plan?.code).toBe(FREE_PLAN_CODE);
    // Explicit and visible, rather than a special case buried in a query.
    // Signup does not create a subscription, because a billing side effect on
    // that path is a billing side effect on the path that must not fail.
  });

  it("allows what the plan includes", async () => {
    const org = await makeOrg();
    const verdict = await can(org.organizationId, "ai_generations_per_month");
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.limit).toBe(5);
    expect(verdict.remaining).toBe(5);
  });

  it("refuses a capability the plan does not mention at all", async () => {
    // A missing row is "not included", never "unlimited". A capability added
    // next month is off everywhere until somebody grants it, rather than free
    // for everybody until somebody remembers to charge.
    const org = await makeOrg();
    const verdict = await can(org.organizationId, "some_capability_added_later");
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toBe("not-included");
  });

  it("refuses once the monthly allowance is spent", async () => {
    const org = await makeOrg();
    for (let use = 0; use < 5; use++) {
      await recordUse(org.organizationId, "ai_generations_per_month");
    }

    const verdict = await can(org.organizationId, "ai_generations_per_month");
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toBe("limit-reached");
    expect(verdict.used).toBe(5);
  });

  it("gives a lapsed subscription the free shape, not the paid one", async () => {
    const org = await makeOrg();
    const pro = await prisma.plan.findFirstOrThrow({ where: { code: "teacher_pro" } });

    await withTenant(org.organizationId, (tx) =>
      tx.subscription.create({
        data: {
          organizationId: org.organizationId,
          planId: pro.id,
          status: "CANCELLED",
        },
      }),
    );

    const verdict = await can(org.organizationId, "ai_generations_per_month");
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    // Free's five, not Pro's hundred. The account still works, at the free
    // shape, rather than silently keeping what was paid for last quarter.
    expect(verdict.limit).toBe(5);
  });

  it("gives an active subscription what it paid for", async () => {
    const org = await makeOrg();
    const pro = await prisma.plan.findFirstOrThrow({ where: { code: "teacher_pro" } });

    await withTenant(org.organizationId, (tx) =>
      tx.subscription.create({
        data: { organizationId: org.organizationId, planId: pro.id, status: "ACTIVE" },
      }),
    );

    const verdict = await can(org.organizationId, "ai_generations_per_month");
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.limit).toBe(100);
  });
});

describe("the gateway asks the plan before it asks the budget", () => {
  it("refuses when the allowance is gone, without calling a provider", async () => {
    const org = await makeOrg();
    for (let use = 0; use < 5; use++) {
      await recordUse(org.organizationId, "ai_generations_per_month");
    }

    const result = await runTask(task(org));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_ENTITLED");
    // A teacher on Free who has used their five should hear about their plan,
    // not about a dollar ceiling they have never heard of.
    expect(result.message).toContain("plan");
    expect(mock.callCount).toBe(0);
  });

  it("counts a use only when the call worked", async () => {
    const org = await makeOrg();
    mock.always = { kind: "error", message: "provider is down" };

    await runTask(task(org));

    const after = await can(org.organizationId, "ai_generations_per_month");
    expect(after.allowed).toBe(true);
    if (!after.allowed) return;
    // Three attempts failed. A teacher whose five monthly generations were
    // spent on provider timeouts has been charged for nothing.
    expect(after.used).toBe(0);
  });

  it("counts one use when it did", async () => {
    const org = await makeOrg();
    mock.script({ kind: "ok", value: { answer: "42" } });

    const result = await runTask(task(org));
    expect(result.ok).toBe(true);

    const after = await can(org.organizationId, "ai_generations_per_month");
    if (!after.allowed) throw new Error("expected to still be allowed");
    expect(after.used).toBe(1);
    expect(after.remaining).toBe(4);
  });

  it("keeps one organisation's usage off another's counter", async () => {
    const first = await makeOrg();
    const second = await makeOrg();

    mock.script({ kind: "ok", value: { answer: "42" } });
    await runTask(task(first));

    const theirs = await can(second.organizationId, "ai_generations_per_month");
    if (!theirs.allowed) throw new Error("expected to be allowed");
    expect(theirs.used).toBe(0);
  });
});

describe("what a plan looks like to a teacher", () => {
  it("shows every entitlement with what is left", async () => {
    const org = await makeOrg();
    await recordUse(org.organizationId, "ai_generations_per_month", 2);

    const plan = await currentPlan(org.organizationId);
    const generations = plan?.entitlements.find(
      (entitlement) => entitlement.key === "ai_generations_per_month",
    );
    expect(generations?.limit).toBe(5);
    expect(generations?.used).toBe(2);
  });
});
