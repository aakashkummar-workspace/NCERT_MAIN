/**
 * Comparing one class against the median across schools.
 *
 * ---------------------------------------------------------------------------
 * It compares CONCEPTS, never schools
 * ---------------------------------------------------------------------------
 * The output is one of two findings and they need different people to do
 * different things:
 *
 *   - *this idea is harder than we thought* — the median across schools is low,
 *     so a class at 0.45 is where everybody is. That is a message about the
 *     material or where it sits in the year, and reteaching harder is the wrong
 *     response to it.
 *   - *this class is behind on it* — the median is healthy and this class is
 *     materially below. That is a message about this room.
 *
 * What it never produces is a position. No "3rd of 5", no percentile for the
 * school, no ranking, and nothing a school could use to work out who else is
 * in the comparison. That is the same argument that keeps the teacher league
 * table out of the institute console, applied to customers instead of staff:
 * the moment a school knows it is being ranked, the rational move is to avoid
 * measuring the students who would lower the rank — the opposite of what the
 * product is for.
 *
 * Pure, so the sentence a teacher reads is testable and cannot drift from the
 * numbers that produced it.
 */

/**
 * Below this many CONTRIBUTING SCHOOLS there is no benchmark at all.
 *
 * The floor is on schools rather than students, and that is the whole
 * refusal. A "median across schools" over two schools describes those two
 * schools — and with two contributors, each can derive the other's figure from
 * the median and its own. Five is the point where a median stops being a
 * sentence about the participants.
 *
 * `app_concept_benchmark()` in prisma/rls.sql takes the same floor as a
 * parameter and returns no row below it, so the refusal holds in SQL as well
 * as here. Two statements of one rule, the shape `app_branding_entitled`
 * already has, held together by an integration test.
 */
export const MIN_SCHOOLS = 5;

/**
 * Below this many measured students a school contributes NOTHING.
 *
 * Same bar the class read already refuses at, for the same reason: a mean over
 * two students describes which two happened to sit the last paper. It matters
 * more here, because a noisy contribution does not merely mislead one teacher
 * — it moves what every other school is told is normal.
 */
export const MIN_MEASURED_TO_CONTRIBUTE = 3;

/** A gap smaller than this is noise, and naming it is a claim about nothing. */
export const MATERIAL_GAP = 0.1;

/**
 * At or below this, the median itself is the finding.
 *
 * Every school being at 0.5 on an idea says the idea is hard, or is taught too
 * early — not that every class needs reteaching.
 */
export const HARD_EVERYWHERE_AT = 0.6;

export type Benchmark = {
  /** How many schools are in the median. Never fewer than MIN_SCHOOLS. */
  schools: number;
  /** Students behind all of them, summed. A denominator, not a ranking. */
  students: number;
  median: number;
  p25: number;
  p75: number;
};

export type Verdict =
  /** The median is low: the idea is hard wherever it is taught. */
  | "hard-everywhere"
  /** Healthy median, this class materially below it. */
  | "behind"
  /** Materially above. Said plainly, and never as a rank. */
  | "ahead"
  /** Within noise of the median. */
  | "in-line";

export type Comparison = {
  verdict: Verdict;
  /** The sentence a teacher reads, built from these numbers. */
  sentence: string;
  benchmark: Benchmark;
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * The finding, in a sentence built from the figures it used.
 *
 * `classMean` is the class figure the analytics page already refuses to
 * produce below its own threshold, so a caller with null has nothing to
 * compare and gets the benchmark on its own.
 */
export function compare(
  classMean: number | null,
  benchmark: Benchmark,
  conceptName: string,
): Comparison {
  const across = `Across ${benchmark.schools} schools the middle school sits at ${percent(
    benchmark.median,
  )} on ${conceptName}, with most between ${percent(benchmark.p25)} and ${percent(
    benchmark.p75,
  )}.`;

  if (classMean === null) {
    return {
      verdict: benchmark.median <= HARD_EVERYWHERE_AT ? "hard-everywhere" : "in-line",
      // Nothing measured here yet, so there is no comparison to make — only
      // the shared figure, which is still worth knowing before teaching it.
      sentence: `${across} There is not enough measured here yet to compare.`,
      benchmark,
    };
  }

  const gap = classMean - benchmark.median;

  // The median first, because it changes what the gap MEANS. A class at 0.45
  // against a median of 0.5 is not behind; the idea is hard.
  if (benchmark.median <= HARD_EVERYWHERE_AT && gap > -MATERIAL_GAP) {
    return {
      verdict: "hard-everywhere",
      sentence: `${across} Your ${percent(
        classMean,
      )} is in line with that, so this looks like a hard idea rather than a gap in this class — worth more time in the plan than in reteaching.`,
      benchmark,
    };
  }

  if (gap <= -MATERIAL_GAP) {
    return {
      verdict: "behind",
      sentence: `${across} Your ${percent(
        classMean,
      )} is below it, which points at this class rather than at the idea.`,
      benchmark,
    };
  }

  if (gap >= MATERIAL_GAP) {
    return {
      verdict: "ahead",
      sentence: `${across} Your ${percent(classMean)} is above it.`,
      benchmark,
    };
  }

  return {
    verdict: "in-line",
    sentence: `${across} Your ${percent(classMean)} is in line with that.`,
    benchmark,
  };
}

/**
 * The median of a list, over school means.
 *
 * Exported and pure so the SQL and the TypeScript can be held against each
 * other: `app_concept_benchmark()` computes the same figure with
 * `percentile_cont`, and a test asserts they agree on the same input.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  if (sorted.length % 2 === 1) return sorted[Math.floor(middle)]!;
  // Interpolated, the way percentile_cont does it — not the lower of the two,
  // or four schools and five would disagree for no reason a reader could see.
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Linear-interpolated quantile, matching `percentile_cont`. */
export function quantile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}
