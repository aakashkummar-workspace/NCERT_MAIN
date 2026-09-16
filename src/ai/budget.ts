import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Spending limits, checked before the call.
 *
 * A budget reconciled after the fact is a report, not a control — by the time
 * it fires the money is gone. So the gateway asks this first, and a request
 * that would exceed the limit never reaches a provider.
 *
 * The estimate is deliberately crude and deliberately pessimistic: max output
 * tokens at full price, no cache credit. Refusing a call that would have come
 * in under budget costs a teacher one retry; allowing one that blows through it
 * costs real money and is discovered on an invoice.
 */

export type BudgetPeriod = "DAY" | "MONTH";

/**
 * The default monthly ceiling per organization, in millionths of a dollar.
 * $20 — comfortably above the modelled $0.17 per student per month for a
 * hundred students, and low enough that a runaway loop is a bounded incident.
 */
const DEFAULT_MONTHLY_MICROS = 20_000_000;

/** A day's ceiling, so a single bad afternoon cannot spend the month. */
const DEFAULT_DAILY_MICROS = 3_000_000;

export function defaultLimitMicros(period: BudgetPeriod): number {
  const override = process.env[`AI_BUDGET_${period}_MICROS`];
  if (override && /^\d+$/.test(override)) return Number(override);
  return period === "MONTH" ? DEFAULT_MONTHLY_MICROS : DEFAULT_DAILY_MICROS;
}

export function windowFor(period: BudgetPeriod, now: Date): { start: Date; end: Date } {
  if (period === "MONTH") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { start, end };
  }
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const end = new Date(start.getTime() + 86_400_000);
  return { start, end };
}

export type BudgetVerdict =
  | { ok: true; remainingMicros: number }
  | { ok: false; period: BudgetPeriod; limitMicros: number; spentMicros: number };

/**
 * Would this call fit?
 *
 * Checks every period, tightest first, and reports which one refused — "you
 * have spent today's allowance" and "you have spent the month" need different
 * things done about them.
 */
export async function checkBudget(
  tx: Prisma.TransactionClient,
  organizationId: string,
  estimateMicros: number,
  now = new Date(),
): Promise<BudgetVerdict> {
  let tightest = Number.POSITIVE_INFINITY;

  for (const period of ["DAY", "MONTH"] as const) {
    const { start, end } = windowFor(period, now);
    const row = await tx.aIBudget.findFirst({
      where: {
        organizationId,
        period,
        feature: null,
        windowStart: start,
      },
    });

    const limit = row ? Number(row.limitMicros) : defaultLimitMicros(period);
    const spent = row ? Number(row.spentMicros) : 0;
    const remaining = limit - spent;

    if (spent + estimateMicros > limit) {
      return { ok: false, period, limitMicros: limit, spentMicros: spent };
    }
    tightest = Math.min(tightest, remaining);
    // Touch the row so a window that has never been used still exists to be
    // read on a dashboard. Created here rather than at signup, because a
    // budget row per organization per day for tenants that never call anything
    // is a table that grows for no reason.
    if (!row) {
      await tx.aIBudget.create({
        data: {
          organizationId,
          period,
          feature: null,
          limitMicros: BigInt(limit),
          spentMicros: BigInt(0),
          windowStart: start,
          windowEnd: end,
        },
      });
    }
  }

  return { ok: true, remainingMicros: tightest };
}

/**
 * Record what was actually spent, against every open window.
 *
 * Called for failures too. A retry storm that spends money and produces nothing
 * is invisible in a success-only ledger, and that invisibility is exactly what
 * produces a surprise bill.
 */
export async function recordSpend(
  tx: Prisma.TransactionClient,
  organizationId: string,
  micros: number,
  now = new Date(),
): Promise<void> {
  if (micros <= 0) return;

  for (const period of ["DAY", "MONTH"] as const) {
    const { start, end } = windowFor(period, now);
    // findFirst then write, rather than upsert: `feature` is nullable and part
    // of the unique, and Prisma will not accept a null inside a compound unique
    // key. The row is created by checkBudget before any call is made, so the
    // update path is the normal one.
    const row = await tx.aIBudget.findFirst({
      where: { organizationId, period, feature: null, windowStart: start },
    });

    if (row) {
      await tx.aIBudget.update({
        where: { id: row.id },
        data: { spentMicros: { increment: BigInt(micros) } },
      });
    } else {
      await tx.aIBudget.create({
        data: {
          organizationId,
          period,
          feature: null,
          limitMicros: BigInt(defaultLimitMicros(period)),
          spentMicros: BigInt(micros),
          windowStart: start,
          windowEnd: end,
        },
      });
    }
  }
}
