import "server-only";
import { withTenant } from "@/db/tenant";
import { organizationsWithStaleMastery } from "@/db/maintenance";
import { recordAttemptEvidence, recomputeMastery } from "./ledger";

/**
 * Keeping the ledger up with the marking, without ever standing in its way.
 *
 * ---------------------------------------------------------------------------
 * Why this is not inside the submit transaction
 * ---------------------------------------------------------------------------
 * Submission is the one path in this product that must not fail. A thirty
 * question paper mapped to two concepts each is sixty upserts, and putting them
 * inside the transaction that finishes a student's exam means a slow query, a
 * lock, or a bug in concept mapping can lose somebody their paper.
 *
 * So the paper is committed first and the ledger follows. If the ledger write
 * fails, the student has still submitted, still been marked, and still sees
 * their result — the only thing missing is a mastery estimate, which is
 * recomputable from `attempt_answers` whenever anyone asks. That is the whole
 * reason the ledger is derived rather than authoritative.
 *
 * `rebuildMastery` is the other half of that promise, and it is not only a
 * repair tool: when the estimator changes — and its third version will not look
 * like its first — this is what re-derives every past estimate from evidence
 * that never moved.
 */

export type SyncResult = {
  ok: boolean;
  written: number;
  concepts: number;
  /** Present when the sync failed. Recorded, never thrown at a student. */
  error?: string;
};

export async function syncAttemptMastery(
  organizationId: string,
  attemptId: string,
  now = new Date(),
): Promise<SyncResult> {
  try {
    const outcome = await withTenant(organizationId, (tx) =>
      recordAttemptEvidence(tx, organizationId, attemptId, now),
    );
    return { ok: true, written: outcome.written, concepts: outcome.concepts.length };
  } catch (error) {
    // Deliberately swallowed. See the note above: the paper is already safe,
    // and a mastery estimate that arrives late is a smaller failure than an
    // exam submission that errors.
    console.error(
      `[mastery] could not record evidence for attempt ${attemptId}:`,
      error,
    );
    return {
      ok: false,
      written: 0,
      concepts: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type RebuildReport = {
  attempts: number;
  evidence: number;
  estimates: number;
};

/**
 * Re-derive an organization's whole ledger from its answers.
 *
 * Every estimate this produces must equal what the incremental path produced,
 * because both call the same estimator over the same rows. A difference is a
 * bug in the cache, never a second opinion — there is an integration test that
 * asserts exactly that.
 */
export async function rebuildMastery(
  organizationId: string,
  now = new Date(),
): Promise<RebuildReport> {
  const attemptIds = await withTenant(organizationId, async (tx) => {
    const rows = await tx.attempt.findMany({
      where: { status: { not: "IN_PROGRESS" } },
      select: { id: true },
      orderBy: { submittedAt: "asc" },
    });
    return rows.map((row) => row.id);
  });

  let evidence = 0;
  const pairs = new Set<string>();

  for (const attemptId of attemptIds) {
    const outcome = await withTenant(organizationId, (tx) =>
      recordAttemptEvidence(tx, organizationId, attemptId, now),
    );
    evidence += outcome.written;
  }

  // Recompute every pair that has evidence, not only the ones this run touched.
  // A concept whose last evidence is a year old still needs its estimate to
  // decay — otherwise a student who stopped answering keeps yesterday's number
  // forever, which is the failure the recency weighting exists to prevent.
  const stale = await withTenant(organizationId, (tx) =>
    tx.conceptEvidence.findMany({
      select: { studentUserId: true, conceptId: true },
      distinct: ["studentUserId", "conceptId"],
    }),
  );

  for (const pair of stale) {
    pairs.add(`${pair.studentUserId}:${pair.conceptId}`);
    await withTenant(organizationId, (tx) =>
      recomputeMastery(tx, organizationId, pair.studentUserId, pair.conceptId, now),
    );
  }

  return { attempts: attemptIds.length, evidence, estimates: pairs.size };
}

export type RefreshReport = {
  organizations: number;
  estimates: number;
  failures: { organizationId: string; message: string }[];
};

/**
 * Recompute estimates the clock has made stale.
 *
 * The estimate decays with time, and time passes whether or not a student
 * answers anything. Without this, a student who stopped work in July keeps
 * July's confident number into December — the recency weighting never fires for
 * exactly the people it matters most for, and a teacher looking at the class in
 * December is reading the summer.
 *
 * Asks which tenants have stale rows, then works one tenant at a time inside
 * withTenant(), like the expiry sweep. One tenant's failure is recorded rather
 * than fatal: the next run finds the same rows still stale and tries again.
 */
export async function refreshStaleMastery(
  olderThanMs = 24 * 3600_000,
  now = new Date(),
): Promise<RefreshReport> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const organizationIds = await organizationsWithStaleMastery(cutoff);

  let estimates = 0;
  const failures: RefreshReport["failures"] = [];

  for (const organizationId of organizationIds) {
    try {
      const stale = await withTenant(organizationId, (tx) =>
        tx.studentConceptMastery.findMany({
          where: { computedAt: { lt: cutoff } },
          select: { studentUserId: true, conceptId: true },
        }),
      );

      for (const row of stale) {
        await withTenant(organizationId, (tx) =>
          recomputeMastery(tx, organizationId, row.studentUserId, row.conceptId, now),
        );
        estimates++;
      }
    } catch (error) {
      failures.push({
        organizationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { organizations: organizationIds.length, estimates, failures };
}
