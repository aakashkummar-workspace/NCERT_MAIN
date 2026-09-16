/**
 * The mastery estimator.
 *
 * Pure, and that is not a stylistic preference. A mastery figure is the number
 * this product asks a teacher to change a lesson plan on and a parent to worry
 * about. It has to be re-derivable from the stored evidence, months later, by
 * somebody who was not in the room — which a function that reads a database
 * cannot be.
 *
 * ---------------------------------------------------------------------------
 * What this is not
 * ---------------------------------------------------------------------------
 * `correct / attempted`. A percentage over three questions is noise presented
 * as a fact, and a teacher who acts on it once and is wrong stops trusting the
 * product permanently. Everything below exists to avoid that one failure.
 *
 * ---------------------------------------------------------------------------
 * The model
 * ---------------------------------------------------------------------------
 * A Beta posterior over "the probability this student answers a question on
 * this concept correctly". Each piece of evidence adds weighted pseudo-counts:
 *
 *     alpha += w_right(difficulty) x recency x mapping x score
 *     beta  += w_wrong(difficulty) x recency x mapping x (1 - score)
 *
 * and the estimate is the posterior mean, `alpha / (alpha + beta)`.
 *
 * Beta rather than a running average because it carries its own uncertainty:
 * the same 0.6 from three answers and from thirty is a different claim, and the
 * spread of the posterior is exactly that difference. That is what makes the
 * refusal rule below expressible at all.
 *
 * Deliberately simple. Item discrimination — how well a question separates
 * students who know the concept from those who do not — needs observed item
 * statistics, which need real attempts at scale. It arrives in Phase 2, and the
 * ledger exists so that every estimate here can be recomputed when it does.
 */

export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export type Evidence = {
  /**
   * Marks earned as a fraction, 0..1.
   *
   * Not a boolean. Two marks out of three is neither right nor wrong, and
   * rounding it at the ledger throws away information the estimator wants and
   * can never get back.
   */
  score: number;
  difficulty: Difficulty;
  /**
   * How much of the question's evidence belongs to this concept: 1.0 for the
   * primary outcome, less for a secondary one. A question that touches a
   * concept in passing should not move it as far as one written to test it.
   */
  mapping: number;
  observedAt: Date;
};

export type Band =
  | "CRITICAL"
  | "FRAGILE"
  | "DEVELOPING"
  | "SECURE"
  | "INSUFFICIENT";

/**
 * The result, as a discriminated union — so a component physically cannot read
 * a number that the estimator refused to produce.
 *
 * The refusal used to be a rule people had to remember ("do not render an
 * estimate when the band is INSUFFICIENT"). Here it is a type error instead,
 * which is the only version of a rule that survives a busy afternoon.
 */
export type Mastery =
  | {
      band: "INSUFFICIENT";
      evidenceCount: number;
      effectiveEvidence: number;
      lastEvidenceAt: Date | null;
      /** Why there is no number, in words a person can act on. */
      reason: "no-evidence" | "too-few-answers" | "evidence-too-old";
    }
  | {
      band: "CRITICAL" | "FRAGILE" | "DEVELOPING" | "SECURE";
      estimate: number;
      confidence: number;
      evidenceCount: number;
      effectiveEvidence: number;
      lastEvidenceAt: Date;
    };

/**
 * Four answers. Below this the posterior is still mostly the prior, and the
 * number would be a restatement of our own assumption dressed as a measurement.
 */
export const MIN_EVIDENCE = 4;

/**
 * And enough evidence that has not decayed away. Five answers from eighteen
 * months ago is a fact about last year, not about this student now — the raw
 * count alone would let stale evidence keep a confident-looking number alive
 * long after it stopped being true.
 */
export const MIN_EFFECTIVE_EVIDENCE = 2;

/**
 * Ninety days. Roughly a term: evidence from the start of the year still
 * counts for something at the end of it, and counts for much less than
 * yesterday's.
 */
export const HALF_LIFE_DAYS = 90;

/**
 * How hard the question was, in both directions.
 *
 * A correct answer on a hard item says more than a correct answer on an easy
 * one — and the mirror matters just as much: getting an EASY item wrong is the
 * single most informative thing a student can do, because almost nobody does.
 * A model that only rewarded hard correct answers would let a student fail
 * every easy question and still look fine.
 */
const WEIGHTS: Record<Difficulty, { right: number; wrong: number }> = {
  EASY: { right: 0.7, wrong: 1.3 },
  MEDIUM: { right: 1.0, wrong: 1.0 },
  HARD: { right: 1.3, wrong: 0.7 },
};

/**
 * A uniform Beta(1, 1) prior: before any evidence, every ability is equally
 * plausible. Deliberately not centred on a guess about how the class does —
 * a prior that assumed 0.5 would quietly pull every sparse estimate towards
 * "average" and make a struggling student look better than they are.
 */
const PRIOR = 1;

/** The standard deviation of Beta(1, 1) — the most uncertain we ever are. */
const MAX_SD = Math.sqrt(1 / 12);

const DAY_MS = 86_400_000;

export function estimateMastery(
  evidence: Evidence[],
  now = new Date(),
): Mastery {
  if (evidence.length === 0) {
    return {
      band: "INSUFFICIENT",
      evidenceCount: 0,
      effectiveEvidence: 0,
      lastEvidenceAt: null,
      reason: "no-evidence",
    };
  }

  let alpha = PRIOR;
  let beta = PRIOR;
  let effective = 0;
  let lastEvidenceAt = evidence[0]!.observedAt;

  for (const item of evidence) {
    const score = clamp(item.score, 0, 1);
    const mapping = clamp(item.mapping, 0, 1);
    const weights = WEIGHTS[item.difficulty];

    const ageDays = Math.max(
      0,
      (now.getTime() - item.observedAt.getTime()) / DAY_MS,
    );
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);

    const base = recency * mapping;
    alpha += base * weights.right * score;
    beta += base * weights.wrong * (1 - score);
    effective += base;

    if (item.observedAt > lastEvidenceAt) lastEvidenceAt = item.observedAt;
  }

  if (evidence.length < MIN_EVIDENCE) {
    return {
      band: "INSUFFICIENT",
      evidenceCount: evidence.length,
      effectiveEvidence: round(effective),
      lastEvidenceAt,
      reason: "too-few-answers",
    };
  }

  if (effective < MIN_EFFECTIVE_EVIDENCE) {
    return {
      band: "INSUFFICIENT",
      evidenceCount: evidence.length,
      effectiveEvidence: round(effective),
      lastEvidenceAt,
      reason: "evidence-too-old",
    };
  }

  const estimate = alpha / (alpha + beta);

  // The spread of the posterior, turned into a 0..1 confidence. Beta(1,1) is
  // the most uncertain we can be, so it is the scale.
  const variance =
    (alpha * beta) / ((alpha + beta) * (alpha + beta) * (alpha + beta + 1));
  const confidence = clamp(1 - Math.sqrt(variance) / MAX_SD, 0, 1);

  return {
    band: bandFor(estimate),
    estimate: round(estimate),
    confidence: round(confidence),
    evidenceCount: evidence.length,
    effectiveEvidence: round(effective),
    lastEvidenceAt,
  };
}

/**
 * The bands from DESIGN_SYSTEM.md section 2.4. Reserved, ordered, and never
 * reused for anything else.
 */
export function bandFor(
  estimate: number,
): "CRITICAL" | "FRAGILE" | "DEVELOPING" | "SECURE" {
  if (estimate >= 0.8) return "SECURE";
  if (estimate >= 0.6) return "DEVELOPING";
  if (estimate >= 0.4) return "FRAGILE";
  return "CRITICAL";
}

export type Trend = "IMPROVING" | "STABLE" | "DECLINING" | "UNKNOWN";

/**
 * Movement since the previous estimate.
 *
 * The threshold is not decoration. Mastery wobbles by a point or two every time
 * a student answers anything, and an arrow that flips between "improving" and
 * "declining" on that noise trains a teacher to ignore it — which costs more
 * than showing nothing.
 */
export const TREND_THRESHOLD = 0.05;

export function trendFor(
  estimate: number | null,
  previous: number | null,
): Trend {
  if (estimate === null || previous === null) return "UNKNOWN";
  const delta = estimate - previous;
  if (delta >= TREND_THRESHOLD) return "IMPROVING";
  if (delta <= -TREND_THRESHOLD) return "DECLINING";
  return "STABLE";
}

/** The estimate, or null. Never a number the band said not to show. */
export function displayableEstimate(mastery: Mastery): number | null {
  return mastery.band === "INSUFFICIENT" ? null : mastery.estimate;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

const round = (value: number) => Math.round(value * 1000) / 1000;
