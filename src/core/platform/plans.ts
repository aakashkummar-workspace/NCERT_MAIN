import "server-only";
import { z } from "zod";
import { platformPrisma } from "@/db/platform";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";

/**
 * Which plan an organisation is on — read and changed from the platform console.
 *
 * ---------------------------------------------------------------------------
 * Why this exists before there is a payment provider
 * ---------------------------------------------------------------------------
 * Every paid capability is gated by `can()`, and a subscription row is the only
 * thing that moves an organisation off the free fallback. Without this screen
 * the only way to give a school the plan it has agreed to — or to give our own
 * organisation the features we are demonstrating — was an INSERT over psql,
 * which is exactly the kind of unaudited cross-tenant write the rest of the
 * product refuses. So a platform admin chooses the plan here, it is written
 * inside the SCHOOL's own tenant transaction like any other subscription write,
 * and it is audited on both sides.
 *
 * `provider` is stamped "manual" so that, the day a payment provider arrives,
 * nobody mistakes a hand-set plan for one somebody paid for.
 */

export type Actor = { organizationId: string; userId: string };

export type OrganizationPlanRow = {
  id: string;
  name: string;
  slug: string;
  type: string;
  createdAt: Date;
  planCode: string;
  planName: string;
  /** No subscription row: the free fallback, not a chosen plan. */
  isFallback: boolean;
  status: string | null;
};

export const SEARCH_LIMIT = 50;

export async function listPlans() {
  return platformPrisma.plan.findMany({
    orderBy: { sortOrder: "asc" },
    select: { code: true, name: true, pricePaise: true, isPublic: true },
  });
}

/**
 * Organisations matching a name or slug, newest first.
 *
 * Search, not a list: this database holds thousands of test tenants, and a
 * console that renders all of them is one nobody can use. The result says when
 * it is truncated.
 */
export async function searchOrganizations(query: string): Promise<{
  rows: OrganizationPlanRow[];
  truncated: boolean;
}> {
  const q = query.trim();
  const orgs = await platformPrisma.organization.findMany({
    where: {
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { slug: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: SEARCH_LIMIT + 1,
    select: { id: true, name: true, slug: true, type: true, createdAt: true },
  });
  const truncated = orgs.length > SEARCH_LIMIT;
  const page = orgs.slice(0, SEARCH_LIMIT);

  const plans = await platformPrisma.plan.findMany({ select: { id: true, code: true, name: true } });
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const free = plans.find((plan) => plan.code === "free");

  // Subscriptions are tenant data, so each is read inside its own tenant.
  const rows: OrganizationPlanRow[] = [];
  for (const org of page) {
    const subscription = await withTenant(org.id, (tx) =>
      tx.subscription.findFirst({
        where: { organizationId: org.id },
        select: { planId: true, status: true },
      }),
    );
    const plan = subscription ? planById.get(subscription.planId) : free;
    rows.push({
      ...org,
      planCode: plan?.code ?? "free",
      planName: plan?.name ?? "Free",
      isFallback: !subscription,
      status: subscription?.status ?? null,
    });
  }
  return { rows, truncated };
}

export type SetPlanResult =
  | { ok: true; planName: string }
  | { ok: false; code: "NOT_FOUND" | "UNKNOWN_PLAN"; message: string };

export async function setOrganizationPlan(
  actor: Actor,
  organizationId: string,
  planCode: string,
): Promise<SetPlanResult> {
  if (!z.uuid().safeParse(organizationId).success) {
    return { ok: false, code: "NOT_FOUND", message: "We could not find that organisation." };
  }
  const [org, plan] = await Promise.all([
    platformPrisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { id: true, name: true },
    }),
    platformPrisma.plan.findUnique({ where: { code: planCode }, select: { id: true, code: true, name: true } }),
  ]);
  if (!org) return { ok: false, code: "NOT_FOUND", message: "We could not find that organisation." };
  if (!plan) return { ok: false, code: "UNKNOWN_PLAN", message: "There is no plan with that code." };

  const before = await withTenant(organizationId, async (tx) => {
    const existing = await tx.subscription.findFirst({
      where: { organizationId },
      select: { planId: true, status: true },
    });
    await tx.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        planId: plan.id,
        status: "ACTIVE",
        provider: "manual",
      },
      update: {
        planId: plan.id,
        status: "ACTIVE",
        provider: "manual",
        cancelledAt: null,
        currentPeriodStart: new Date(),
      },
    });
    // The school's own log says who changed its plan, because "why can we
    // suddenly write reports" is asked inside the school, not in our console.
    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: actor.userId,
        actorRole: "PLATFORM_ADMIN",
        action: "subscription.plan_set",
        entityType: "subscription",
        entityId: organizationId,
        before: existing ? { planId: existing.planId, status: existing.status } : { plan: "free fallback" },
        after: { planCode: plan.code, status: "ACTIVE", provider: "manual" },
      },
    });
    return existing;
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: "PLATFORM_ADMIN",
    action: "platform.organization_plan_set",
    entityType: "organization",
    entityId: organizationId,
    before: before ? { planId: before.planId } : { plan: "free fallback" },
    after: { organizationName: org.name, planCode: plan.code },
  });

  return { ok: true, planName: plan.name };
}
