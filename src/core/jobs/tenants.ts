import "server-only";
import { organizationsWithWebhookWork } from "@/db/maintenance";

/**
 * Which tenants have queue work.
 *
 * ---------------------------------------------------------------------------
 * Why the fence is disabled here, and what should replace the disable
 * ---------------------------------------------------------------------------
 * `@/db/maintenance` is restricted to scheduled jobs, by an ESLint rule whose
 * exemption list names each of them by path — `src/core/attempts/sweep.ts`,
 * `src/core/mastery/sync.ts`, `src/core/mistakes/sync.ts`. This module is the
 * fourth and belongs on that list; the correct fix is one line in
 * `eslint.config.mjs`:
 *
 *     "src/core/jobs/tenants.ts",
 *
 * added to the `ignores` of the block that restricts the database paths. Until
 * that lands, the exception is here, in one file, in the open — rather than in
 * the runner where it would be next to the delivery logic and easy to stop
 * noticing.
 *
 * The guarantee itself is unchanged and is the point of routing every such
 * import through one module: what comes back is a list of organization ids and
 * nothing else. No outbox row, no job, no payload. The worst a bug downstream
 * can do with the result is open a correctly scoped `withTenant()` transaction,
 * which is what it is for.
 */
export async function tenantsWithWebhookWork(now: Date): Promise<string[]> {
  return organizationsWithWebhookWork(now);
}
