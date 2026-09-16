import "server-only";
import type { JobStatus, Prisma } from "@prisma/client";

/**
 * The queue, exactly as DATABASE_SCHEMA.md section 9 settled it.
 *
 * ---------------------------------------------------------------------------
 * Postgres, and no Redis
 * ---------------------------------------------------------------------------
 * `for update skip locked` is what makes that a real answer rather than a
 * compromise. It is one statement, it is atomic, and two runners racing over
 * the same rows do not queue behind each other — the second one skips what the
 * first has locked and takes the next rows instead. No leader election, no
 * second datastore to keep up, and — the part that matters here — the queue
 * lives inside the same transaction and the same RLS policies as everything
 * else, so a job cannot be a way around tenancy.
 *
 * Everything in this file is generic. It knows about claiming, backoff and
 * exhaustion; it knows nothing about webhooks. `core/webhooks/runner.ts` is
 * what gives it work to do.
 */

/** How long a claim is good for before another runner may take it back. */
export const LOCK_MS = 5 * 60 * 1000;

export type ClaimedJob = {
  id: string;
  organizationId: string;
  type: string;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
};

/**
 * Add work.
 *
 * `dedupeKey` is what makes running fan-out twice — after a crash, or from two
 * schedulers that both fired — insert nothing the second time. Rows without one
 * are never deduplicated: a plain UNIQUE treats NULLs as distinct, which is the
 * partial index section 9 describes, spelled the way Postgres already behaves.
 */
export async function enqueue(
  tx: Prisma.TransactionClient,
  jobs: {
    organizationId: string;
    queue: string;
    type: string;
    payload: Prisma.InputJsonValue;
    dedupeKey?: string | null;
    priority?: number;
    maxAttempts?: number;
    runAfter?: Date;
  }[],
): Promise<number> {
  if (jobs.length === 0) return 0;
  const result = await tx.job.createMany({
    data: jobs.map((job) => ({
      organizationId: job.organizationId,
      queue: job.queue,
      type: job.type,
      payload: job.payload,
      dedupeKey: job.dedupeKey ?? null,
      priority: job.priority ?? 100,
      maxAttempts: job.maxAttempts ?? 5,
      runAfter: job.runAfter ?? new Date(),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * Return abandoned work to the queue.
 *
 * A runner that is killed mid-delivery — a deploy, an out-of-memory, a machine
 * that simply goes away — leaves a row marked RUNNING and nothing to finish it.
 * Without this it stays that way forever, and the failure mode is the worst
 * kind: the console shows work in progress and no error, indefinitely.
 *
 * The attempt is NOT given back. It was spent, and a job that kills its runner
 * would otherwise be retried without limit, taking the runner with it each time.
 */
export async function reclaimExpired(
  tx: Prisma.TransactionClient,
  queue: string,
  now: Date,
): Promise<number> {
  const result = await tx.job.updateMany({
    where: { queue, status: "RUNNING", lockedUntil: { lt: now } },
    data: { status: "PENDING", lockedBy: null, lockedUntil: null },
  });
  return result.count;
}

/**
 * Take up to `limit` jobs, atomically.
 *
 * Section 9's statement, unchanged. Two properties are load-bearing:
 *
 *   - `for update skip locked` — two runners never deliver the same event
 *     twice, and neither blocks on the other. Without SKIP LOCKED the second
 *     runner waits for the first's transaction; with plain SELECT and no lock
 *     at all, both claim the same rows and the school receives everything
 *     twice.
 *   - `attempts = attempts + 1` on the CLAIM, not on the failure. A job that
 *     crashes the runner never reaches a failure handler, so counting there
 *     would let one poisonous row be retried forever.
 *
 * RLS applies to the inner select as much as the outer update, so this claims
 * within one tenant and cannot see another's rows — which is why the runner
 * loops tenants rather than draining a global queue.
 */
export async function claim(
  tx: Prisma.TransactionClient,
  input: { queue: string; limit: number; lockedBy: string; now: Date },
): Promise<ClaimedJob[]> {
  const lockedUntil = new Date(input.now.getTime() + LOCK_MS);

  const rows = await tx.$queryRaw<
    {
      id: string;
      organization_id: string;
      type: string;
      payload: Prisma.JsonValue;
      attempts: number;
      max_attempts: number;
    }[]
  >`
    update jobs
       set status = 'RUNNING',
           locked_by = ${input.lockedBy},
           locked_until = ${lockedUntil},
           attempts = attempts + 1
     where id in (
       select id from jobs
        where status = 'PENDING'
          and run_after <= ${input.now}
          and queue = ${input.queue}
        order by priority, run_after
        limit ${input.limit}
        for update skip locked
     )
    returning id, organization_id, type, payload, attempts, max_attempts
  `;

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }));
}

export async function markSucceeded(
  tx: Prisma.TransactionClient,
  id: string,
  now: Date,
): Promise<void> {
  await tx.job.updateMany({
    where: { id },
    data: {
      status: "SUCCEEDED",
      finishedAt: now,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
    },
  });
}

/** Back to PENDING, to be tried again after `runAfter`. */
export async function markRetry(
  tx: Prisma.TransactionClient,
  id: string,
  input: { runAfter: Date; failure: string },
): Promise<void> {
  await tx.job.updateMany({
    where: { id },
    data: {
      status: "PENDING",
      runAfter: input.runAfter,
      lastError: input.failure,
      lockedBy: null,
      lockedUntil: null,
    },
  });
}

/**
 * Terminal.
 *
 * `DEAD` means the attempts ran out; `FAILED` means we refused, and retrying
 * would produce the same refusal at the same cost. The row is kept either way —
 * section 9 is explicit that an exhausted job "goes DEAD and raises an alert
 * rather than disappearing", and a deleted row cannot answer the question
 * somebody asks two months later, which is always "was this one sent".
 */
export async function markTerminal(
  tx: Prisma.TransactionClient,
  id: string,
  input: { status: Extract<JobStatus, "DEAD" | "FAILED">; failure: string; now: Date },
): Promise<void> {
  await tx.job.updateMany({
    where: { id },
    data: {
      status: input.status,
      finishedAt: input.now,
      lastError: input.failure,
      lockedBy: null,
      lockedUntil: null,
    },
  });
}
