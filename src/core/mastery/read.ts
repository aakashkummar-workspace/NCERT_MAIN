import "server-only";
import { withTenant } from "@/db/tenant";
import { conceptContext } from "@/core/curriculum/concepts";
import type { Band, Trend } from "./estimate";

export type { Coverage } from "@/core/curriculum/concepts";
export { conceptCoverage } from "@/core/curriculum/concepts";

/**
 * Reading mastery.
 *
 * The one rule every function here holds: **`estimate` is null whenever `band`
 * is INSUFFICIENT**, and it is null because the column is null, not because a
 * caller remembered to hide it. A number the estimator refused to produce never
 * enters the process.
 */

export type ConceptMastery = {
  conceptId: string;
  conceptName: string;
  /** The chapters this concept is tested by, for a student to recognise it. */
  chapters: string[];
  subjects: string[];
  band: Band;
  /** Null when the band is INSUFFICIENT. Always. */
  estimate: number | null;
  confidence: number | null;
  evidenceCount: number;
  trend: Trend;
  lastEvidenceAt: Date | null;
};

/**
 * Everything we believe about one student.
 *
 * Ordered weakest first, and INSUFFICIENT last. A student opening this wants
 * "where do I start", and a list that led with the things they already know
 * would answer a question nobody asked.
 */
export async function studentMastery(
  organizationId: string,
  studentUserId: string,
): Promise<ConceptMastery[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.studentConceptMastery.findMany({ where: { studentUserId } }),
  );
  if (rows.length === 0) return [];

  const context = await conceptContext(rows.map((row) => row.conceptId));

  return rows
    .map((row) => ({
      conceptId: row.conceptId,
      conceptName: context.get(row.conceptId)?.name ?? "Unknown concept",
      chapters: context.get(row.conceptId)?.chapters ?? [],
      subjects: context.get(row.conceptId)?.subjects ?? [],
      band: row.band as Band,
      estimate: row.estimate === null ? null : Number(row.estimate),
      confidence: row.confidence === null ? null : Number(row.confidence),
      evidenceCount: row.evidenceCount,
      trend: row.trend as Trend,
      lastEvidenceAt: row.lastEvidenceAt,
    }))
    .sort(byWeakestFirst);
}

const BAND_ORDER: Record<Band, number> = {
  CRITICAL: 0,
  FRAGILE: 1,
  DEVELOPING: 2,
  SECURE: 3,
  // Last, not first. "We don't know yet" is not a problem to fix, and putting
  // it at the top of a list headed "where to start" would send a student to
  // practise something nobody has established they cannot do.
  INSUFFICIENT: 4,
};

function byWeakestFirst(a: ConceptMastery, b: ConceptMastery): number {
  const bands = BAND_ORDER[a.band] - BAND_ORDER[b.band];
  if (bands !== 0) return bands;
  return (a.estimate ?? 1) - (b.estimate ?? 1);
}

