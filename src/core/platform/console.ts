import "server-only";
import { platformPrisma } from "@/db/platform";

/**
 * The two cross-tenant views the platform operator needs to run this.
 *
 * ---------------------------------------------------------------------------
 * Why this is allowed to see across tenants, and how narrowly
 * ---------------------------------------------------------------------------
 * Everything else in the product is scoped by `withTenant`. These are not,
 * because "what is the AI costing us this month" and "what happened to this
 * organization's data last Tuesday" are questions about the platform, not about
 * one customer.
 *
 * The reach is bounded three ways rather than by convention:
 *
 *   1. It runs on the `sahayak_platform` connection, which is separate from the
 *      one the app holds. A teacher-facing route physically cannot use it.
 *   2. Its policies are `for select` only. This role cannot write a ledger or
 *      touch an audit row.
 *   3. It reaches exactly three tables — usage, generations, audit — and none
 *      of them carries a student's work, a name, or an answer.
 *
 * The `/admin` pages on top of this are gated on `platform_admin`, which is a
 * column on `users` granted only by a script over `DIRECT_URL`. There is
 * deliberately no in-app way to promote an account.
 */

export type CostWindow = {
  from: Date;
  to: Date;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costMicros: number;
  /** What the same calls would have cost with no cache hits. */
  uncachedMicros: number;
  byFeature: {
    feature: string;
    calls: number;
    costMicros: number;
  }[];
  byOrganization: {
    organizationId: string | null;
    name: string;
    calls: number;
    costMicros: number;
  }[];
};

export async function aiCosts(days = 30, now = new Date()): Promise<CostWindow> {
  const from = new Date(now.getTime() - days * 86_400_000);

  const rows = await platformPrisma.aIUsage.findMany({
    where: { createdAt: { gte: from } },
    select: {
      organizationId: true,
      feature: true,
      status: true,
      inputTokens: true,
      outputTokens: true,
      cachedInputTokens: true,
      costMicros: true,
    },
  });

  const byFeature = new Map<string, { calls: number; costMicros: number }>();
  const byOrganization = new Map<string, { calls: number; costMicros: number }>();

  let calls = 0;
  let failures = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costMicros = 0;

  for (const row of rows) {
    calls++;
    // Failures counted, and counted separately. A retry storm that spends money
    // and produces nothing is invisible in a success-only view, and that
    // invisibility is what produces a surprise bill.
    if (row.status !== "SUCCEEDED") failures++;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cachedInputTokens += row.cachedInputTokens;
    costMicros += Number(row.costMicros);

    const feature = byFeature.get(row.feature) ?? { calls: 0, costMicros: 0 };
    feature.calls++;
    feature.costMicros += Number(row.costMicros);
    byFeature.set(row.feature, feature);

    const orgKey = row.organizationId ?? "platform";
    const organization = byOrganization.get(orgKey) ?? { calls: 0, costMicros: 0 };
    organization.calls++;
    organization.costMicros += Number(row.costMicros);
    byOrganization.set(orgKey, organization);
  }

  const names = await organizationNames([...byOrganization.keys()]);

  return {
    from,
    to: now,
    calls,
    failures,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costMicros,
    // The cache saving, made visible. A caching discipline nobody can measure
    // is one that quietly stops working, and cache_read going to zero roughly
    // triples the bill with no other symptom.
    uncachedMicros: costMicros + estimateCacheSaving(cachedInputTokens),
    byFeature: [...byFeature]
      .map(([feature, totals]) => ({ feature, ...totals }))
      .sort((a, b) => b.costMicros - a.costMicros),
    byOrganization: [...byOrganization]
      .map(([organizationId, totals]) => ({
        organizationId: organizationId === "platform" ? null : organizationId,
        name: names.get(organizationId) ?? "Platform",
        ...totals,
      }))
      .sort((a, b) => b.costMicros - a.costMicros)
      .slice(0, 25),
  };
}

/**
 * Roughly what the cached tokens would have cost at full price.
 *
 * A cached read is a tenth of a fresh one, so the nine tenths saved is the
 * figure worth showing. Deliberately approximate and labelled as such on the
 * page — it spans tiers with different prices, and a precise number here would
 * imply an accuracy it does not have.
 */
function estimateCacheSaving(cachedTokens: number): number {
  const BALANCED_INPUT_PER_MTOK = 2.0;
  const saved = (cachedTokens * BALANCED_INPUT_PER_MTOK * 0.9) / 1_000_000;
  return Math.ceil(saved * 1_000_000);
}

async function organizationNames(ids: string[]): Promise<Map<string, string>> {
  const real = ids.filter((id) => id !== "platform");
  if (real.length === 0) return new Map();

  const organizations = await platformPrisma.organization.findMany({
    where: { id: { in: real } },
    select: { id: true, name: true },
  });
  return new Map(organizations.map((organization) => [organization.id, organization.name]));
}

export type AuditRow = {
  id: string;
  organizationId: string | null;
  organizationName: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: Date;
};

/**
 * Audit search.
 *
 * Filters, never full text: an audit log is searched by who, what and when,
 * and a free-text query over a table this size is a table scan somebody runs
 * during an incident.
 *
 * `before` and `after` are NOT returned. They can hold the shape of whatever
 * changed, and an operator answering "did we delete that class" does not need
 * a student's phone number on screen to do it.
 */
export async function searchAudit(
  filters: {
    organizationId?: string;
    action?: string;
    entityType?: string;
    /** How far back to look. The clock lives here, not in a page. */
    withinDays?: number;
    limit?: number;
  },
  now = new Date(),
): Promise<AuditRow[]> {
  const since =
    filters.withinDays === undefined
      ? undefined
      : new Date(now.getTime() - filters.withinDays * 86_400_000);

  const rows = await platformPrisma.auditLog.findMany({
    where: {
      ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
      ...(filters.action ? { action: { contains: filters.action } } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      actorUserId: true,
      actorRole: true,
      action: true,
      entityType: true,
      entityId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(filters.limit ?? 100, 200),
  });

  const names = await organizationNames(
    rows.flatMap((row) => (row.organizationId ? [row.organizationId] : [])),
  );

  return rows.map((row) => ({
    ...row,
    organizationName: row.organizationId
      ? (names.get(row.organizationId) ?? "Unknown")
      : "Platform",
  }));
}

/** The distinct actions on record, for a filter that cannot be mistyped. */
export async function auditActions(): Promise<string[]> {
  const rows = await platformPrisma.auditLog.findMany({
    select: { action: true },
    distinct: ["action"],
    orderBy: { action: "asc" },
    take: 100,
  });
  return rows.map((row) => row.action);
}
