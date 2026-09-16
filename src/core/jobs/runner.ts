import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { tenantsWithWebhookWork } from "./tenants";
import { claim, markRetry, markSucceeded, markTerminal, reclaimExpired, type ClaimedJob } from "./queue";

/**
 * The pass.
 *
 * ---------------------------------------------------------------------------
 * The ordering is the design, and it is the AI gateway's ordering
 * ---------------------------------------------------------------------------
 *   find tenants → per tenant: reclaim → fan out → claim → handle → settle
 *
 * Read it the way `src/ai/gateway.ts` reads. Reclaim comes FIRST, because work
 * abandoned by a runner that died is older than anything about to be queued and
 * a pass that claimed before reclaiming would leave it a full cycle behind.
 * Fan-out comes before the claim so an event written a second ago can go out in
 * this pass rather than the next. And settling comes last and unconditionally,
 * including for the failures — a job that is handled and not settled stays
 * RUNNING until its lock expires, which is a delivery delayed five minutes for
 * no reason and, in the log, a delivery that looks stuck.
 *
 * ---------------------------------------------------------------------------
 * One tenant at a time, under RLS
 * ---------------------------------------------------------------------------
 * A sweep written the obvious way — one connection, one query, every row —
 * finishes the first customer's work and abandons everybody else's, because RLS
 * shows a query exactly one organization. So the pass asks which tenants have
 * work (ids only, through the one module allowed to ask) and then does the work
 * inside `withTenant()`, exactly like the expiry sweep and the mastery refresh.
 * There is no privileged connection here to leak.
 *
 * ---------------------------------------------------------------------------
 * Settling in its own transaction
 * ---------------------------------------------------------------------------
 * The claim commits before the handler runs, and the outcome is written after.
 * Holding the claim transaction open across an HTTP call to somebody else's
 * server would hold a connection and its row locks for as long as that server
 * takes to answer — up to the ten-second timeout, times the batch — which is
 * precisely the pool burst `withTenant`'s own comment warns about. The cost is
 * that a runner dying between the two leaves a RUNNING row, which is exactly
 * what `reclaimExpired` is for.
 */

export type JobOutcome =
  | { ok: true }
  | { ok: false; retryable: true; failure: string; runAfter: Date }
  | { ok: false; retryable: false; failure: string };

export type RunReport = {
  organizations: number;
  queued: number;
  claimed: number;
  delivered: number;
  retrying: number;
  dead: number;
  refused: number;
  /** Tenants that threw. Recorded, never fatal — see below. */
  failures: { organizationId: string; message: string }[];
};

export type RunOptions = {
  queue: string;
  /** How many jobs one tenant may be given in a single pass. */
  batchSize?: number;
  now?: Date;
  /** Turn whatever is waiting into jobs. Returns how many were queued. */
  fanOut: (
    tx: Prisma.TransactionClient,
    organizationId: string,
    now: Date,
  ) => Promise<number>;
  /** Do one job. Must not throw; if it does, the job is retried. */
  handle: (
    organizationId: string,
    job: ClaimedJob,
    now: Date,
  ) => Promise<JobOutcome>;
  /** Called once per job that has exhausted its attempts. */
  onDead?: (organizationId: string, job: ClaimedJob, failure: string) => Promise<void>;
};

export async function runQueue(options: RunOptions): Promise<RunReport> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 25;
  const lockedBy = `runner-${randomUUID().slice(0, 8)}`;

  const organizationIds = await tenantsWithWebhookWork(now);

  const report: RunReport = {
    organizations: organizationIds.length,
    queued: 0,
    claimed: 0,
    delivered: 0,
    retrying: 0,
    dead: 0,
    refused: 0,
    failures: [],
  };

  for (const organizationId of organizationIds) {
    try {
      const claimed = await withTenant(organizationId, async (tx) => {
        await reclaimExpired(tx, options.queue, now);
        report.queued += await options.fanOut(tx, organizationId, now);
        return claim(tx, {
          queue: options.queue,
          limit: batchSize,
          lockedBy,
          now,
        });
      });

      report.claimed += claimed.length;

      for (const job of claimed) {
        const outcome = await runOne(options, organizationId, job, now);
        if (outcome === "delivered") report.delivered += 1;
        else if (outcome === "retrying") report.retrying += 1;
        else if (outcome === "dead") report.dead += 1;
        else report.refused += 1;
      }
    } catch (error) {
      // One tenant's bad row must not stop the other nine hundred. Reported so
      // it is visible in the cron log; the next pass finds the same work,
      // because the query that finds it is the same query either way.
      report.failures.push({
        organizationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

async function runOne(
  options: RunOptions,
  organizationId: string,
  job: ClaimedJob,
  now: Date,
): Promise<"delivered" | "retrying" | "dead" | "refused"> {
  let outcome: JobOutcome;
  try {
    outcome = await options.handle(organizationId, job, now);
  } catch (error) {
    // The handler is documented as not throwing. This is here because "must
    // not throw" is a property of today's handler and the runner has to survive
    // tomorrow's — an unsettled job would otherwise sit RUNNING for the whole
    // lock.
    outcome = {
      ok: false,
      retryable: true,
      failure: `unknown: ${error instanceof Error ? error.message : String(error)}`,
      runAfter: new Date(now.getTime() + 60_000),
    };
  }

  if (outcome.ok) {
    await withTenant(organizationId, (tx) => markSucceeded(tx, job.id, now));
    return "delivered";
  }

  if (!outcome.retryable) {
    await withTenant(organizationId, (tx) =>
      markTerminal(tx, job.id, {
        status: "FAILED",
        failure: outcome.failure,
        now,
      }),
    );
    return "refused";
  }

  // `attempts` was incremented by the claim, so it already counts this try.
  if (job.attempts >= job.maxAttempts) {
    await withTenant(organizationId, (tx) =>
      markTerminal(tx, job.id, { status: "DEAD", failure: outcome.failure, now }),
    );
    await options.onDead?.(organizationId, job, outcome.failure);
    return "dead";
  }

  await withTenant(organizationId, (tx) =>
    markRetry(tx, job.id, { runAfter: outcome.runAfter, failure: outcome.failure }),
  );
  return "retrying";
}
