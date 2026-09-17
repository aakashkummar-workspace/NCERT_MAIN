import "server-only";
import { cache } from "react";
import { withTenant } from "@/db/tenant";
import { planEntitlements } from "./plans";

/**
 * `can(organizationId, "ai_generations_per_month")`.
 *
 * ---------------------------------------------------------------------------
 * No price is hard-coded anywhere in the application
 * ---------------------------------------------------------------------------
 * Not in this file either. Every limit comes from an `entitlements` row reached
 * through the organization's active subscription. Adding a plan, moving a
 * limit, or running a promotion is data — never a deploy, and never a code
 * review.
 *
 * ---------------------------------------------------------------------------
 * A missing row means "not included"
 * ---------------------------------------------------------------------------
 * Never "unlimited". The default has to be the restrictive one: a capability
 * added next month is then off everywhere until somebody grants it, rather than
 * free for everybody until somebody remembers to charge. The failure modes are
 * not symmetric — one is a support ticket, the other is a quarter of giving
 * away the expensive thing.
 *
 * ---------------------------------------------------------------------------
 * An organization with no subscription
 * ---------------------------------------------------------------------------
 * Falls back to the plan coded `free`. Signup does not create a subscription
 * row today, and inventing one at signup would put a billing side effect on the
 * one path that must not fail. The fallback is explicit and visible rather than
 * a special case buried in a query.
 */

export const FREE_PLAN_CODE = "free";

export type Verdict =
  | { allowed: true; limit: number | null; used: number; remaining: number | null }
  | { allowed: false; reason: "not-included" | "limit-reached"; limit: number; used: number };

/**
 * Whether an organization may do one more of something.
 *
 * `used` is read from `usage_counters`, which is about the thing being sold —
 * "5 AI generations a month" is a product promise. `ai_budgets` is about money
 * and is a separate control; conflating them would let a price change silently
 * move a safety limit.
 */
export async function can(
  organizationId: string,
  key: string,
  now = new Date(),
): Promise<Verdict> {
  const entitlement = await entitlementFor(organizationId, key);

  if (!entitlement) {
    return { allowed: false, reason: "not-included", limit: 0, used: 0 };
  }

  if (entitlement.unlimited) {
    return { allowed: true, limit: null, used: 0, remaining: null };
  }

  // A boolean capability: granted, with no count to keep.
  if (entitlement.limitValue <= 0) {
    return { allowed: false, reason: "not-included", limit: 0, used: 0 };
  }

  const used = await usageFor(organizationId, key, now);
  if (used >= entitlement.limitValue) {
    return {
      allowed: false,
      reason: "limit-reached",
      limit: entitlement.limitValue,
      used,
    };
  }

  return {
    allowed: true,
    limit: entitlement.limitValue,
    used,
    remaining: entitlement.limitValue - used,
  };
}

/**
 * Count one use.
 *
 * Called after the thing succeeded, not before. A generation that failed did
 * not consume the promise — a teacher whose five monthly generations were spent
 * on provider timeouts has been charged for nothing, and would be right to say
 * so.
 */
export async function recordUse(
  organizationId: string,
  key: string,
  amount = 1,
  now = new Date(),
): Promise<void> {
  const periodStart = monthStart(now);

  await withTenant(organizationId, async (tx) => {
    const existing = await tx.usageCounter.findFirst({
      where: { organizationId, key, periodStart },
    });
    if (existing) {
      await tx.usageCounter.update({
        where: { id: existing.id },
        data: { value: { increment: amount } },
      });
      return;
    }
    await tx.usageCounter.create({
      data: { organizationId, key, periodStart, value: amount },
    });
  });
}

export type PlanSummary = {
  code: string;
  name: string;
  pricePaise: number;
  interval: string;
  status: string;
  /** Every entitlement on the plan, with what has been used this month. */
  entitlements: { key: string; limit: number | null; used: number }[];
};

/** What an organization is on, and how much of it is left. */
export async function currentPlan(
  organizationId: string,
  now = new Date(),
): Promise<PlanSummary | null> {
  const subscription = await withTenant(organizationId, (tx) =>
    tx.subscription.findFirst({ where: { organizationId } }),
  );

  const plan = await planEntitlements(
    subscription?.planId ?? null,
    FREE_PLAN_CODE,
  );
  if (!plan) return null;

  const periodStart = monthStart(now);
  const counters = await withTenant(organizationId, (tx) =>
    tx.usageCounter.findMany({ where: { organizationId, periodStart } }),
  );
  const usedByKey = new Map(counters.map((row) => [row.key, row.value]));

  return {
    code: plan.code,
    name: plan.name,
    pricePaise: plan.pricePaise,
    interval: plan.interval,
    // No subscription row means the free fallback, and it says so rather than
    // pretending somebody signed up for something.
    status: subscription?.status ?? "TRIALING",
    entitlements: plan.entitlements.map((entitlement) => ({
      key: entitlement.key,
      limit: entitlement.unlimited ? null : entitlement.limitValue,
      used: usedByKey.get(entitlement.key) ?? 0,
    })),
  };
}

/**
 * One subscription read and one plan read per render, not one per `can()`.
 * A page checks several capabilities, and each check was two network round
 * trips. Per-request only (React `cache`); route handlers read fresh.
 */
const subscriptionFor = cache((organizationId: string) =>
  withTenant(organizationId, (tx) => tx.subscription.findFirst({ where: { organizationId } })),
);
const cachedPlanEntitlements = cache(planEntitlements);

async function entitlementFor(organizationId: string, key: string) {
  const subscription = await subscriptionFor(organizationId);

  // A subscription that has lapsed does not keep its entitlements. Falling back
  // to free is the honest behaviour: the account still works, at the free
  // shape, rather than silently keeping what was paid for last quarter.
  const active =
    subscription &&
    (subscription.status === "ACTIVE" || subscription.status === "TRIALING");

  const plan = await cachedPlanEntitlements(
    active ? subscription.planId : null,
    FREE_PLAN_CODE,
  );
  return plan?.entitlements.find((entitlement) => entitlement.key === key) ?? null;
}

async function usageFor(organizationId: string, key: string, now: Date) {
  const periodStart = monthStart(now);
  const counter = await withTenant(organizationId, (tx) =>
    tx.usageCounter.findFirst({ where: { organizationId, key, periodStart } }),
  );
  return counter?.value ?? 0;
}

const monthStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
