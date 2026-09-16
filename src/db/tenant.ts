import type { Prisma } from "@prisma/client";
import { prisma } from "./client";

/**
 * How long a tenant transaction may run, and how long it may wait for a
 * connection.
 *
 * ---------------------------------------------------------------------------
 * These were Prisma's defaults, and nobody had chosen them
 * ---------------------------------------------------------------------------
 * `$transaction(fn)` with no options is `maxWait: 2000, timeout: 5000`. Every
 * tenant query in the product goes through here, so those two numbers governed
 * the whole application and neither had been thought about.
 *
 * `timeout` is the one that surfaced: a heatmap over a large class, a marking
 * queue, a term report — any of them can legitimately exceed five seconds on a
 * loaded database, and when it does the transaction is already dead and the
 * work is lost. It showed up as two "flaky" integration tests failing with
 * *Transaction already closed*, in different suites, both passing alone.
 *
 * `maxWait` is the more dangerous one, and it had not failed yet. It is how
 * long a caller waits for a free connection before giving up. A class of thirty
 * students submitting within the same minute is precisely a pool burst, and
 * submitting goes through this function — so a two-second wait failing means a
 * student is told their paper could not be handed in, on the one path in this
 * product that must not fail.
 *
 * ---------------------------------------------------------------------------
 * Raising them is not the fix for a slow query
 * ---------------------------------------------------------------------------
 * A transaction held for fifteen seconds holds a connection and its row locks
 * for fifteen seconds, and everybody else waits. These are headroom for
 * legitimate work under load, not permission for a query to be slow: anything
 * routinely approaching the timeout is a query to fix, and the number is
 * deliberately explicit here so that raising it again is a decision somebody
 * makes rather than a default that drifts.
 */
export const TRANSACTION_TIMEOUT_MS = Number(
  process.env.DB_TRANSACTION_TIMEOUT_MS ?? 15_000,
);
export const TRANSACTION_MAX_WAIT_MS = Number(
  process.env.DB_TRANSACTION_MAX_WAIT_MS ?? 10_000,
);

/**
 * The only sanctioned path to tenant data.
 *
 * Opens a transaction, sets the tenant context for that transaction only, and
 * runs the callback. Every query inside is filtered by the RLS policies in
 * prisma/rls.sql.
 *
 *     const classes = await withTenant(orgId, (tx) => tx.class.findMany());
 *
 * ---------------------------------------------------------------------------
 * Why the third argument to set_config is `true`
 * ---------------------------------------------------------------------------
 * `true` is is_local: the setting is scoped to this transaction and is discarded
 * on COMMIT or ROLLBACK.
 *
 * With a transaction-mode connection pooler in front of Postgres — which is
 * every managed provider this deploys on — connections are handed to whichever
 * request needs one next. A session-level SET therefore leaks onto the next
 * request that borrows that connection, and it reads another organization's
 * rows with no error, no exception and no log line.
 *
 * That `true` is the entire defence. It is not optional and it is not a
 * performance detail.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(organizationId)) {
    // Not merely defensive: this value is interpolated into set_config below,
    // and a non-UUID here means a caller has passed something it should not
    // have — very possibly something from a request body.
    throw new Error("withTenant: organizationId is not a UUID");
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`;
      return fn(tx);
    },
    { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: TRANSACTION_TIMEOUT_MS },
  );
}

/**
 * Runs with NO tenant context. Every RLS policy evaluates against a NULL
 * organization, so this sees nothing in any tenant table — which is the point.
 * Used only to prove, in tests, that the policies deny rather than allow by
 * default.
 */
export async function withoutTenant<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx), {
    maxWait: TRANSACTION_MAX_WAIT_MS,
    timeout: TRANSACTION_TIMEOUT_MS,
  });
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
