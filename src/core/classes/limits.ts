import "server-only";
import { withTenant } from "@/db/tenant";
import { can } from "@/core/billing/entitlements";

/**
 * Plan limits on classes and students.
 *
 * These are STOCK limits — how many exist now — not the monthly flow that
 * `usage_counters` keeps for AI generations. So the plan says how many, through
 * `can()`, and the count comes from the rows themselves. A counter here would
 * drift the first time a class was archived or a student removed.
 *
 * The number is data: nothing in this file knows what Free allows.
 */

export type Seats = {
  /** null means the plan sets no limit. */
  limit: number | null;
  used: number;
  /** null means unlimited; 0 means none left (or not included at all). */
  remaining: number | null;
};

async function limitFor(organizationId: string, key: string): Promise<number | null> {
  const verdict = await can(organizationId, key);
  if (verdict.allowed) return verdict.limit;
  // A missing row is "not included", never "unlimited".
  return verdict.reason === "not-included" ? 0 : verdict.limit;
}

export async function classSeats(organizationId: string): Promise<Seats> {
  const [limit, used] = await Promise.all([
    limitFor(organizationId, "max_classes"),
    withTenant(organizationId, (tx) =>
      tx.class.count({ where: { deletedAt: null, status: "ACTIVE" } }),
    ),
  ]);
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
}

export async function studentSeats(organizationId: string): Promise<Seats> {
  const [limit, used] = await Promise.all([
    limitFor(organizationId, "max_students"),
    withTenant(organizationId, (tx) =>
      tx.membership.count({ where: { organizationId, role: "STUDENT", status: "ACTIVE" } }),
    ),
  ]);
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
}

export function classLimitMessage(seats: Seats): string {
  return seats.limit === 0
    ? "Your plan does not include classes. See Settings for what your plan includes."
    : `Your plan's class limit is ${seats.limit}, and it has been reached. Archive a class or change plan in Settings to add another.`;
}

export function studentLimitReason(seats: Seats): string {
  return `Over your plan's student limit of ${seats.limit}. Change plan in Settings to add more.`;
}
