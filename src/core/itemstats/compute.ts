/**
 * Classical item statistics — how a question ACTUALLY behaved.
 *
 * Pure, for the same reason `core/mastery/estimate.ts` is pure and not as a
 * matter of taste. These figures are what a teacher retires a question on, or
 * re-keys it on, and they have to be re-derivable months later from the stored
 * responses by somebody who was not in the room. A function that reads a
 * database cannot be checked by hand; this one can, and the unit test beside it
 * pins every number against an arithmetic worked out on paper.
 *
 * ===========================================================================
 * THE CONSTRAINT THAT MATTERS MORE THAN ANY OF THE MATHS BELOW
 * ===========================================================================
 * **Observed difficulty sits BESIDE declared difficulty. It never replaces it,
 * and nothing in this file may reach the mastery estimator.**
 *
 * The temptation is obvious and it is wrong. A teacher marked a question
 * MEDIUM; three hundred responses later the p-value says 0.91, which is EASY by
 * any classical reading. Writing that back to `questions.difficulty` looks like
 * the product getting cleverer. It is in fact three separate failures at once:
 *
 *  1. **It silently moves every mastery figure in the product.** `WEIGHTS` in
 *     `core/mastery/estimate.ts` is keyed on difficulty: a correct answer on a
 *     HARD item adds 1.3 and on an EASY item 0.7, and getting an EASY item
 *     wrong costs 1.3. Re-labelling one question therefore re-weights every
 *     past and future piece of evidence that ran through it — and mastery is
 *     upstream of learning gaps, interventions, the study plan, practice
 *     recommendations, the Copilot and term reports. A change nobody asked for,
 *     landing in a document a parent keeps.
 *  2. **It destroys the teacher's stated intent with no audit trail.** The
 *     declared difficulty is a judgement about what the question ASKS of a
 *     student. The p-value is a fact about how one cohort in one school
 *     answered it — which can be high because the item is easy, and equally
 *     because the class was taught it last week, or because the stem gives the
 *     answer away, or because the key is wrong and everyone picked the same
 *     wrong option. Those are different findings with different fixes, and only
 *     a person can tell them apart.
 *  3. **It makes the estimator un-re-derivable.** The two-table split in
 *     `concept_evidence` / `student_concept_mastery` exists so that every past
 *     estimate can be recomputed from the ledger. Evidence rows do not carry
 *     the difficulty they were weighted with — it is read from the question. A
 *     difficulty that drifts under them means `rebuildMastery` produces
 *     different numbers on Tuesday from the ones it produced on Monday, with
 *     nothing recording why.
 *
 * So the output here is a SECOND OPINION, shown next to the first one, with the
 * disagreement flagged in words. The teacher decides. Nothing is written back;
 * in fact nothing is written at all — see the next note.
 *
 * ===========================================================================
 * NO TABLE, NO MIGRATION — derived at read time
 * ===========================================================================
 * There is deliberately no `item_statistics` table and no migration behind
 * this. A stored statistic is stale the moment the next paper is marked, which
 * would mean either a cron flipping rows (and a row that is a lie between
 * ticks — the exact failure an assignment's status column was refused for) or a
 * recompute hook on the marking path, which is a hot path that must not get
 * slower. These figures are read on demand, from one question's detail page,
 * by one teacher, and that is not a hot path at all. Same rule as the study
 * plan: derived at read time and stored nowhere.
 *
 * ===========================================================================
 * What is NOT here
 * ===========================================================================
 * Item response theory. A 2PL or 3PL model estimates difficulty and
 * discrimination on a common scale across papers, which is the right answer and
 * needs several hundred responses per item plus a linking design. Classical
 * statistics are what this data can support; they are also what a teacher can
 * check by hand, which matters more than it sounds.
 */

export type Difficulty = "EASY" | "MEDIUM" | "HARD";

/**
 * One student's answer to one item, on one sitting of one paper.
 *
 * The reader assembles these; nothing in this file knows about a database, a
 * tenant or an attempt.
 */
export type ItemResponse = {
  /**
   * A stable identifier — the attempt answer's id.
   *
   * Only used to break ties in the ranking below. Two students on the same
   * total score have to be split somehow, and splitting them by whatever order
   * the database happened to return would let the discrimination index move
   * between two page loads on unchanged data. That is the same defect the
   * marking queue had before it was given an explicit `orderBy`.
   */
  id: string;
  /**
   * Marks awarded on THIS item, as a fraction of the marks available, 0..1.
   *
   * A fraction rather than a boolean because CBSE questions carry partial
   * credit: 2 of 3 is neither right nor wrong, and rounding it here would throw
   * away information the correlation below wants. For a one-mark objective item
   * it is exactly 0 or 1, and then the p-value is the classical proportion
   * correct.
   */
  score: number;
  /** The whole paper as a fraction, 0..1. The ranking key for the 27% split. */
  totalScore: number;
  /**
   * The paper MINUS this item, as a fraction, 0..1 — or null when the paper had
   * only this one item and there is no rest to speak of.
   *
   * This is what the point-biserial is computed against, and the correction is
   * not pedantry. On a ten-item paper an item contributes a tenth of the total
   * and correlates perfectly with itself, so an uncorrected item-total
   * correlation flatters every item — and it flatters the bad ones most, since
   * a mis-keyed item whose true correlation with ability is negative gets
   * dragged back towards zero by its own marks. The one figure that exists to
   * catch a wrong answer key must not be the figure that hides it.
   */
  restScore: number | null;
  /**
   * Option keys the student selected, for the types that have options. Null for
   * everything else. An empty array is a student who chose nothing.
   */
  chosenKeys: string[] | null;
};

export type OptionInput = { key: string; text: string; isCorrect: boolean };

/**
 * Thirty responses, and it refuses below that with no number at all.
 *
 * ---------------------------------------------------------------------------
 * Why thirty
 * ---------------------------------------------------------------------------
 * Classical item analysis is conventionally described as unstable below about
 * 30 responses and comfortable somewhere north of 100. Thirty is chosen as the
 * FLOOR — the point below which the figures stop describing the question and
 * start describing which students happened to sit it — not as the point at
 * which they become good:
 *
 *  - A p-value near 0.5 over 30 responses has a standard error of about 0.09.
 *    That is roughly the width of a whole difficulty band, so at n = 30 the
 *    observed difficulty can be one band out by chance alone. It is reported
 *    anyway because it is reported BESIDE the teacher's own judgement rather
 *    than instead of it; it would be indefensible if it overwrote anything.
 *  - The 27% split at n = 30 gives groups of 8. One student moves the
 *    discrimination index by 0.125, which is most of the distance between
 *    "poor" and "good". So D is treated as a direction, not a measurement, and
 *    the only claim this module makes loudly is the sign.
 *  - Below 30 the point-biserial's confidence interval spans zero for any
 *    correlation a real item produces, which makes it worse than silence.
 *
 * The alternative to a floor is a provisional figure with a hedge next to it,
 * and this product has repeatedly found that a hedged number is read as a
 * number. So: no number, and a sentence saying how many responses exist and how
 * many are needed. The same refusal `core/mastery` makes below MIN_EVIDENCE and
 * `core/results` makes below MIN_TO_SUMMARISE.
 *
 * ---------------------------------------------------------------------------
 * And this threshold is hard to reach, honestly
 * ---------------------------------------------------------------------------
 * Statistics are computed PER TENANT and per question VERSION. A tuition centre
 * with one Class 10 of 24 students will never reach 30 responses on a question
 * used once, and will reach it on the second or third paper that reuses the
 * item. That is a real limitation and it is the price of a rule this product
 * states deliberately: *"Two centres may legitimately hold the same question
 * and neither learns about the other's bank."*
 *
 * Pooling across organizations is the change that would fix it, and it is not a
 * decision this module gets to make. It would need the curriculum plane's
 * shape — a shared, platform-owned item whose responses are contributed rather
 * than owned — plus an answer to what a school is agreeing to when its
 * students' answers inform another school's question quality. Somebody else's
 * decision, on purpose.
 */
export const MIN_RESPONSES = 30;

/** The fraction of the cohort in each extreme group. Kelley's 27%. */
export const GROUP_FRACTION = 0.27;

export type DiscriminationBand =
  | "NEGATIVE"
  | "POOR"
  | "FAIR"
  | "GOOD"
  | "EXCELLENT";

export type OptionStat = {
  key: string;
  text: string;
  isCorrect: boolean;
  /** How many students chose it. */
  chosen: number;
  /** As a share of responses, 0..1. */
  share: number;
  /** Chosen by the strongest 27% and by the weakest 27%. */
  upperChosen: number;
  lowerChosen: number;
  /**
   * Nobody ever picked it. A distractor nobody chooses is doing no work: the
   * item is a three-option question wearing four options, and every student's
   * guessing odds are better than the paper says.
   */
  dead: boolean;
  /**
   * A distractor more students chose than the key.
   *
   * Occasionally a genuine and interesting misconception. More often the key is
   * simply wrong, which is why it is surfaced next to the discrimination sign
   * rather than on its own.
   */
  outperformsKey: boolean;
};

export type ItemStats =
  | {
      enough: false;
      responses: number;
      needed: number;
      reason: "no-responses" | "too-few-responses";
      /** Always available — it is the teacher's own judgement, not a measurement. */
      declaredDifficulty: Difficulty;
    }
  | {
      enough: true;
      responses: number;
      /**
       * The proportion of the available marks earned, 0..1.
       *
       * NOTE THE NAME IS BACKWARDS, and everybody meeting it for the first time
       * gets it the wrong way round: a HIGH p-value means an EASY question.
       * p = 0.9 is "nine in ten got it right". It is called a difficulty index
       * in the literature while measuring facility, which is why every screen in
       * this product labels it "how many got it right" and puts the word EASY
       * next to a high one.
       */
      pValue: number;
      /** What the p-value says, in the product's own three bands. */
      observedDifficulty: Difficulty;
      /** What a person said when they wrote it. Never overwritten. See the header. */
      declaredDifficulty: Difficulty;
      /** The two disagree — a prompt to look, never a correction. */
      difficultyDisagrees: boolean;
      /**
       * Upper 27% minus lower 27%, ranked by total paper score, in 0..1 units.
       *
       * The single most important output of this module is its SIGN. A negative
       * discrimination says the students who did best on the paper did WORST on
       * this question, which is almost always a wrong answer key — and until
       * somebody looks, every student who actually knew the material is being
       * marked down for it.
       */
      discrimination: number;
      discriminationBand: DiscriminationBand;
      /** How many responses are in each extreme group — the denominator for D. */
      groupSize: number;
      upperMean: number;
      lowerMean: number;
      /**
       * The correlation between doing well on this item and doing well on the
       * REST of the paper. Null when the paper had a single item, or when
       * everybody scored the same on the item or on the rest — a correlation
       * needs two things that vary.
       */
      pointBiserial: number | null;
      /** Per-option counts, for the types that have options. Null otherwise. */
      options: OptionStat[] | null;
      /**
       * Something is probably wrong with the answer key: the discrimination is
       * negative, or a distractor beat the key. Surfaced loudly, and as a
       * question rather than a verdict — a machine overruling a teacher on a
       * judgement is how a product gets turned off.
       */
      keySuspect: boolean;
    };

/**
 * Where the p-value falls, in the same three bands a teacher declares.
 *
 * The cut points are the conventional ones and they are a convention, not a
 * discovery: above 0.7 most of the cohort got it, below 0.4 most did not.
 * Bounds are inclusive at the top of the band, so 0.7 is EASY and 0.4 is
 * MEDIUM — stated because a boundary case is exactly where two people reading
 * the same figure disagree.
 */
export function observedDifficultyFor(pValue: number): Difficulty {
  if (pValue >= 0.7) return "EASY";
  if (pValue >= 0.4) return "MEDIUM";
  return "HARD";
}

/**
 * The conventional Ebel bands for a discrimination index.
 *
 * NEGATIVE is separated from POOR deliberately. Both are bad, and only one of
 * them means the item is actively marking the wrong students down.
 */
export function discriminationBandFor(d: number): DiscriminationBand {
  if (d < 0) return "NEGATIVE";
  if (d >= 0.4) return "EXCELLENT";
  if (d >= 0.3) return "GOOD";
  if (d >= 0.2) return "FAIR";
  return "POOR";
}

export function computeItemStats(
  responses: ItemResponse[],
  declaredDifficulty: Difficulty,
  options: OptionInput[] | null,
): ItemStats {
  const n = responses.length;

  if (n === 0) {
    return {
      enough: false,
      responses: 0,
      needed: MIN_RESPONSES,
      reason: "no-responses",
      declaredDifficulty,
    };
  }

  if (n < MIN_RESPONSES) {
    return {
      enough: false,
      responses: n,
      needed: MIN_RESPONSES,
      reason: "too-few-responses",
      declaredDifficulty,
    };
  }

  const scores = responses.map((r) => clamp(r.score, 0, 1));
  const pValue = mean(scores);
  const observed = observedDifficultyFor(pValue);

  // Ranked by whole-paper score, best first, ties broken by id so the split is
  // the same on every read. `sort` mutates, so the copy is not optional.
  const ranked = [...responses].sort(
    (a, b) => b.totalScore - a.totalScore || a.id.localeCompare(b.id),
  );

  // Kelley's 27%: the split that maximises the difference between the groups
  // while keeping each big enough to mean anything. At least one either side,
  // so the arithmetic is defined for any n that got past the threshold.
  const groupSize = Math.max(1, Math.round(n * GROUP_FRACTION));
  const upper = ranked.slice(0, groupSize);
  const lower = ranked.slice(n - groupSize);

  const upperMean = mean(upper.map((r) => clamp(r.score, 0, 1)));
  const lowerMean = mean(lower.map((r) => clamp(r.score, 0, 1)));
  const discrimination = upperMean - lowerMean;

  const restScores = responses.map((r) => r.restScore);
  const pointBiserial = restScores.some((value) => value === null)
    ? null
    : pearson(scores, restScores as number[]);

  const optionStats = options
    ? countOptions(options, responses, upper, lower)
    : null;

  const distractorBeatsKey = (optionStats ?? []).some(
    (option) => option.outperformsKey,
  );

  return {
    enough: true,
    responses: n,
    pValue: round(pValue),
    observedDifficulty: observed,
    declaredDifficulty,
    difficultyDisagrees: observed !== declaredDifficulty,
    discrimination: round(discrimination),
    discriminationBand: discriminationBandFor(discrimination),
    groupSize,
    upperMean: round(upperMean),
    lowerMean: round(lowerMean),
    pointBiserial: pointBiserial === null ? null : round(pointBiserial),
    options: optionStats,
    keySuspect: discrimination < 0 || distractorBeatsKey,
  };
}

function countOptions(
  options: OptionInput[],
  all: ItemResponse[],
  upper: ItemResponse[],
  lower: ItemResponse[],
): OptionStat[] {
  const tally = (rows: ItemResponse[]) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const key of row.chosenKeys ?? []) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  };

  const overall = tally(all);
  const inUpper = tally(upper);
  const inLower = tally(lower);

  // The key's count, for the "a distractor beat it" comparison. On a
  // multi-select item there is more than one correct option; the strongest of
  // them is the fair comparison, because beating the least-chosen half of a
  // two-part key says nothing.
  const keyCount = Math.max(
    0,
    ...options
      .filter((option) => option.isCorrect)
      .map((option) => overall.get(option.key) ?? 0),
  );
  const hasKey = options.some((option) => option.isCorrect);

  return options.map((option) => {
    const chosen = overall.get(option.key) ?? 0;
    return {
      key: option.key,
      text: option.text,
      isCorrect: option.isCorrect,
      chosen,
      share: all.length === 0 ? 0 : round(chosen / all.length),
      upperChosen: inUpper.get(option.key) ?? 0,
      lowerChosen: inLower.get(option.key) ?? 0,
      dead: chosen === 0,
      outperformsKey: hasKey && !option.isCorrect && chosen > keyCount,
    };
  });
}

/**
 * Pearson's r between the item score and the rest of the paper.
 *
 * For a dichotomous item — 0 or 1 — this is exactly the point-biserial
 * correlation; the point-biserial is not a different statistic, it is Pearson's
 * r with one variable happening to be binary. Computed as Pearson so that a
 * partially credited three-mark answer is handled by the same line of code
 * rather than by a second formula that has to agree with the first.
 *
 * Null when either side has no variance: everybody scoring the same on the item
 * (or on the rest of the paper) makes the correlation 0/0, and returning 0
 * there would read as "no relationship" when the truth is "no question was
 * asked".
 */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;

  const mx = mean(xs);
  const my = mean(ys);

  let covariance = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    covariance += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) return null;
  return covariance / Math.sqrt(varX * varY);
}

const mean = (values: number[]) =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

const round = (value: number) => Math.round(value * 1000) / 1000;
