import { prisma } from "./client";

/**
 * The cross-school read, and the third cross-tenant seam.
 *
 * `unscoped.ts` exists because sign-in cannot scope a lookup — it does not yet
 * know the tenant. `maintenance.ts` exists because a job has to visit every
 * tenant, and its functions therefore return ids and never rows. This module
 * exists for a third shape that is neither: a read whose ANSWER is an
 * aggregate over every tenant, which no amount of tenant-by-tenant work can
 * produce for a page load.
 *
 * ---------------------------------------------------------------------------
 * Why this is safe when a grant would not be
 * ---------------------------------------------------------------------------
 * The alternative was to let the platform connection read
 * `student_concept_mastery`. That connection is documented as reaching four
 * tables that carry no student work, and widening it for a reporting feature
 * would hand a reporting problem every table in the database.
 *
 * So the aggregate is not computed from student rows at all. Each school
 * computes its own mean inside its own tenant transaction and stores one row
 * per concept (`concept_benchmarks`), and this function medians those rows.
 * What crosses the boundary is a median, a spread and two counts.
 *
 * The RETURN SHAPE is the control, not the caller's good behaviour:
 * `app_concept_benchmark()` has no organization_id column, no name, no slug
 * and no per-school row, so a league table cannot be built from what comes
 * out. The school floor lives in the function too, which is why it takes one
 * rather than trusting a caller to filter afterwards.
 *
 * An ESLint rule confines this module to src/core/benchmarks.
 */

export type BenchmarkRow = {
  schools: number;
  students: number;
  median: number;
  p25: number;
  p75: number;
};

/**
 * One concept's benchmark, or null when too few schools contribute.
 *
 * Null is the refusal arriving from the database: below the floor the function
 * returns no row at all, rather than a row of nulls that a caller eventually
 * renders as a dash beside a real-looking label.
 */
export async function conceptBenchmarkRow(
  conceptId: string,
  minSchools: number,
): Promise<BenchmarkRow | null> {
  const rows = await prisma.$queryRaw<
    {
      schools: number;
      students: number;
      median: string | number;
      p25: string | number;
      p75: string | number;
    }[]
  >`select * from app_concept_benchmark(${conceptId}::uuid, ${minSchools}::int)`;

  const row = rows[0];
  if (!row) return null;
  return {
    schools: Number(row.schools),
    students: Number(row.students),
    median: Number(row.median),
    p25: Number(row.p25),
    p75: Number(row.p75),
  };
}

/**
 * Schools that agreed to contribute and have something to contribute from.
 *
 * Ids only, exactly like `maintenance.ts` — the computing happens tenant by
 * tenant inside `withTenant()`. Opting in is checked in SQL rather than in the
 * job, so a job that forgets cannot reach a school that declined.
 */
export async function organizationsForBenchmarks(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ organization_id: string }[]>`
    select * from app_maint_orgs_for_benchmarks()
  `;
  return rows.map((row) => row.organization_id);
}
