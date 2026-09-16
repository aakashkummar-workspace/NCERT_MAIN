import "server-only";
import { organizationsWithExpiredAttempts } from "@/db/maintenance";
import { sweepExpiredAttempts } from "./index";

/**
 * The whole-platform expiry sweep.
 *
 * Why this exists at all: a student who closes the laptop mid-paper leaves an
 * attempt that is IN_PROGRESS forever. Nobody submits it, so nobody marks it,
 * so the teacher's class list shows a permanent blank against a student who
 * sat the test. The sweep is what turns "they stopped" into "they ran out of
 * time", which is the truth.
 *
 * Two properties worth stating, because both are easy to lose later:
 *
 *   - **It is not the clock.** A student sitting the paper is submitted by
 *     their own browser the moment it hits zero; this only picks up sittings
 *     nobody is in. If the sweep is late — or does not run for a day — no
 *     student is affected mid-test, and nothing is lost when it catches up.
 *
 *   - **It runs under RLS like everything else.** It asks which tenants have
 *     work, then does the work one tenant at a time inside withTenant(). There
 *     is no privileged connection to leak, and a bug here can damage exactly
 *     one organization at a time rather than all of them.
 *
 * Submission is idempotent, so a sweep that overlaps a student pressing Submit
 * is harmless: whoever gets there first sets the score, the other returns it.
 */
export type SweepReport = {
  organizations: number;
  attempts: number;
  /** Tenants that threw. Recorded rather than fatal — see below. */
  failures: { organizationId: string; message: string }[];
};

export async function sweepAllOrganizations(
  now = new Date(),
): Promise<SweepReport> {
  const organizationIds = await organizationsWithExpiredAttempts(now);

  let attempts = 0;
  const failures: SweepReport["failures"] = [];

  for (const organizationId of organizationIds) {
    try {
      attempts += await sweepExpiredAttempts(organizationId, now);
    } catch (error) {
      // One tenant's bad row must not stop the other nine hundred. The failure
      // is reported so it is visible in the cron log, and the next run tries
      // again — the query that finds work is the same query either way.
      failures.push({
        organizationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { organizations: organizationIds.length, attempts, failures };
}
