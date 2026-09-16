import "server-only";
import { prisma } from "@/db/client";

/**
 * Plan and entitlement reads.
 *
 * On the global plane with the curriculum and the prompts: plans carry no
 * `organization_id`, their policy is `for select using (true)`, and the app
 * role has no write grant on them at all. So they are read outside
 * `withTenant`, and this file is listed alongside `core/curriculum` in the
 * layering rules for exactly that reason — a tenant able to edit the limits it
 * is billed against is not a feature.
 */

export type PlanWithEntitlements = {
  id: string;
  code: string;
  name: string;
  pricePaise: number;
  interval: string;
  entitlements: { key: string; limitValue: number; unlimited: boolean }[];
};

/**
 * One plan by id, or the named fallback when there is no subscription.
 *
 * The fallback is a parameter rather than a hidden default, so a caller cannot
 * accidentally get "free" when it meant "nothing".
 */
export async function planEntitlements(
  planId: string | null,
  fallbackCode: string,
): Promise<PlanWithEntitlements | null> {
  const plan = await prisma.plan.findFirst({
    where: planId ? { id: planId } : { code: fallbackCode },
    include: { entitlements: true },
  });
  if (!plan) return null;

  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    pricePaise: plan.pricePaise,
    interval: plan.interval,
    entitlements: plan.entitlements.map((entitlement) => ({
      key: entitlement.key,
      limitValue: entitlement.limitValue,
      unlimited: entitlement.unlimited,
    })),
  };
}

/** Everything on the pricing page, cheapest first. */
export async function publicPlans(): Promise<PlanWithEntitlements[]> {
  const plans = await prisma.plan.findMany({
    where: { isPublic: true },
    include: { entitlements: { orderBy: { key: "asc" } } },
    orderBy: [{ sortOrder: "asc" }, { pricePaise: "asc" }],
  });

  return plans.map((plan) => ({
    id: plan.id,
    code: plan.code,
    name: plan.name,
    pricePaise: plan.pricePaise,
    interval: plan.interval,
    entitlements: plan.entitlements.map((entitlement) => ({
      key: entitlement.key,
      limitValue: entitlement.limitValue,
      unlimited: entitlement.unlimited,
    })),
  }));
}
