import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import {
  conceptBenchmarkRow,
  organizationsForBenchmarks,
} from "@/db/benchmarks";
import { writeAudit } from "@/core/identity/audit";
import {
  compare,
  MIN_MEASURED_TO_CONTRIBUTE,
  MIN_SCHOOLS,
  type Benchmark,
  type Comparison,
} from "./compare";

/**
 * Cross-school concept benchmarks.
 *
 * ---------------------------------------------------------------------------
 * The one thing only this architecture allows
 * ---------------------------------------------------------------------------
 * Concepts are global rows shared by every school; evidence is tenant-scoped.
 * That two-plane split was built on day one for exactly this, and nothing had
 * used it: *"your class is at 42% on Nature of the roots; the middle school
 * across five schools is at 61%."* No school sees another's rows — each
 * computes its own mean inside its own tenant and the comparison is a median
 * over those.
 *
 * ---------------------------------------------------------------------------
 * It is also the feature most easily built into a lie
 * ---------------------------------------------------------------------------
 * Four refusals, and they ARE the feature:
 *
 *  1. **A floor on SCHOOLS, not only students.** A median over two schools
 *     describes those two schools, and each of the two can derive the other's
 *     figure from it. Below `MIN_SCHOOLS` there is no number at all — and the
 *     floor is inside `app_concept_benchmark()` as well as here, so it holds
 *     in SQL whatever a caller does.
 *  2. **No school is identifiable, ever, including by elimination.** No
 *     ranking, no "3rd of 5", no named peers, no per-school row. The function's
 *     return shape has no column for a school, so this is structural rather
 *     than a rule to remember.
 *  3. **It compares CONCEPTS, never schools.** The output is "this idea is
 *     harder than we thought" or "this class is behind on it" — see
 *     `compare.ts`. The same argument that keeps the teacher league table out
 *     of the institute console, applied to customers.
 *  4. **Opt-in, and contributing is not the price of reading.** Nothing of a
 *     school's evidence reaches an aggregate until somebody there says so, and
 *     a school that declines still sees the benchmark. Charging for the same
 *     thing twice — once in money, once in data — is how a product that says
 *     it is on the customer's side stops being.
 */

export type Actor = { organizationId: string; userId: string; role: string };

export type BenchmarkResult =
  | ({ ok: true } & Comparison)
  | {
      ok: false;
      reason: "too-few-schools";
      /** Said plainly, because silence looks like a broken page. */
      message: string;
    };

const TOO_FEW =
  `A benchmark needs at least ${MIN_SCHOOLS} schools measuring the same idea. ` +
  `Fewer than that describes the schools in it rather than the idea, so there is no figure yet.`;

/**
 * One concept, compared against the median across schools.
 *
 * `classMean` is the figure `core/analytics` already produced — passed in
 * rather than re-derived, because two functions that both decide what a class
 * is at will disagree eventually, and a page showing both would be arguing
 * with itself.
 */
export async function benchmarkForConcept(
  conceptId: string,
  conceptName: string,
  classMean: number | null,
): Promise<BenchmarkResult> {
  const row = await conceptBenchmarkRow(conceptId, MIN_SCHOOLS);
  if (!row) return { ok: false, reason: "too-few-schools", message: TOO_FEW };

  // Restated here as well as in SQL. Two statements of one rule is deliberate
  // — the SQL cannot be reached around, and this arm is what a test holds
  // against it.
  if (row.schools < MIN_SCHOOLS) {
    return { ok: false, reason: "too-few-schools", message: TOO_FEW };
  }

  const benchmark: Benchmark = {
    schools: row.schools,
    students: row.students,
    median: row.median,
    p25: row.p25,
    p75: row.p75,
  };
  return { ok: true, ...compare(classMean, benchmark, conceptName) };
}

export type ConceptAsk = {
  conceptId: string;
  conceptName: string;
  /** Null when the class read refused, which is a normal state here. */
  classMean: number | null;
};

/**
 * Several concepts at once, for a page that lists them.
 *
 * One query per concept rather than one query for all of them: the aggregate
 * is a `percentile_cont` per concept and the alternative shape — every school's
 * row for every concept, medianed in application code — would pull exactly the
 * per-school figures this feature exists not to expose.
 */
export async function benchmarksForConcepts(
  asks: ConceptAsk[],
): Promise<Map<string, BenchmarkResult>> {
  const out = new Map<string, BenchmarkResult>();
  for (const ask of asks) {
    out.set(
      ask.conceptId,
      await benchmarkForConcept(ask.conceptId, ask.conceptName, ask.classMean),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Opting in
// ---------------------------------------------------------------------------

export async function contributionState(
  organizationId: string,
): Promise<{ contributing: boolean; since: Date | null; concepts: number }> {
  return withTenant(organizationId, async (tx) => {
    const organization = await tx.organization.findFirst({
      where: { id: organizationId },
      select: { benchmarksOptedInAt: true },
    });
    const concepts = await tx.conceptBenchmark.count({});
    return {
      contributing: organization?.benchmarksOptedInAt !== null,
      since: organization?.benchmarksOptedInAt ?? null,
      concepts,
    };
  });
}

/**
 * Agree to contribute, or withdraw.
 *
 * Withdrawing DELETES this school's rows rather than only clearing the stamp.
 * A withdrawal that leaves the numbers in the aggregate is not a withdrawal,
 * and "we stopped updating it" is not an answer anybody accepts a year later.
 */
export async function setContributing(
  actor: Actor,
  contributing: boolean,
): Promise<{ ok: true; removed: number }> {
  const removed = await withTenant(actor.organizationId, async (tx) => {
    await tx.organization.update({
      where: { id: actor.organizationId },
      data: { benchmarksOptedInAt: contributing ? new Date() : null },
    });
    if (contributing) return 0;
    const gone = await tx.conceptBenchmark.deleteMany({});
    return gone.count;
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: contributing ? "benchmarks.opted_in" : "benchmarks.opted_out",
    entityType: "organization",
    entityId: actor.organizationId,
    // The count, because "did our figures actually come out" is the question
    // somebody asks after withdrawing.
    after: { contributing, removed },
  });

  return { ok: true, removed };
}

// ---------------------------------------------------------------------------
// Contributing
// ---------------------------------------------------------------------------

export type ContributionReport = {
  organizations: number;
  concepts: number;
  skippedThin: number;
};

/**
 * Recompute what every opted-in school contributes.
 *
 * Runs tenant by tenant inside `withTenant()`, under the same policies as a
 * browser request — the job is handed ids and nothing else. A school's
 * contribution is a mean over ITS OWN measured students, per student rather
 * than per mastery row, so one keen student with thirty measured concepts
 * cannot count thirty times.
 */
export async function refreshContributions(): Promise<ContributionReport> {
  const organizationIds = await organizationsForBenchmarks();
  const report: ContributionReport = {
    organizations: 0,
    concepts: 0,
    skippedThin: 0,
  };

  for (const organizationId of organizationIds) {
    const outcome = await contributeFor(organizationId);
    report.organizations += 1;
    report.concepts += outcome.concepts;
    report.skippedThin += outcome.skippedThin;
  }
  return report;
}

/**
 * One school's contribution.
 *
 * Exported for the tests and for a support run against a single school; the
 * job goes through `refreshContributions`.
 */
export async function contributeFor(
  organizationId: string,
): Promise<{ concepts: number; skippedThin: number }> {
  return withTenant(organizationId, async (tx) => {
    // Only what the estimator stood behind. A row the product refused to put a
    // number on has `estimate = null` and an INSUFFICIENT band, and averaging
    // those in would put this school's noise into what every other school is
    // told is normal.
    const grouped = await tx.studentConceptMastery.groupBy({
      by: ["conceptId"],
      where: { estimate: { not: null }, band: { not: "INSUFFICIENT" } },
      _avg: { estimate: true },
      _count: { studentUserId: true },
    });

    let concepts = 0;
    let skippedThin = 0;
    const kept = new Set<string>();

    for (const row of grouped) {
      const measured = row._count.studentUserId;
      const mean = row._avg.estimate;
      if (mean === null) continue;
      // A school with two measured students contributes NOTHING on that
      // concept. The same bar the class read refuses at, and it matters more
      // here: a thin contribution does not mislead one teacher, it moves the
      // figure every other school is compared against.
      if (measured < MIN_MEASURED_TO_CONTRIBUTE) {
        skippedThin += 1;
        continue;
      }

      const estimate = new Prisma.Decimal(Number(mean).toFixed(3));
      const existing = await tx.conceptBenchmark.findFirst({
        where: { conceptId: row.conceptId },
        select: { id: true },
      });
      if (existing) {
        await tx.conceptBenchmark.update({
          where: { id: existing.id },
          data: {
            measuredStudents: measured,
            meanEstimate: estimate,
            computedAt: new Date(),
          },
        });
      } else {
        await tx.conceptBenchmark.createMany({
          data: [
            {
              id: randomUUID(),
              organizationId,
              conceptId: row.conceptId,
              measuredStudents: measured,
              meanEstimate: estimate,
            },
          ],
        });
      }
      kept.add(row.conceptId);
      concepts += 1;
    }

    // A concept this school no longer measures enough of stops contributing.
    // Left behind, its stale mean would go on moving other schools' medians
    // after the class that produced it moved on — and a figure nothing can
    // refresh is a figure nobody can explain.
    const stale = await tx.conceptBenchmark.findMany({
      select: { id: true, conceptId: true },
    });
    const drop = stale.filter((row) => !kept.has(row.conceptId)).map((row) => row.id);
    if (drop.length > 0) {
      await tx.conceptBenchmark.deleteMany({ where: { id: { in: drop } } });
    }

    return { concepts, skippedThin };
  });
}

export { MIN_SCHOOLS, MIN_MEASURED_TO_CONTRIBUTE };
export type { Benchmark, Comparison };
