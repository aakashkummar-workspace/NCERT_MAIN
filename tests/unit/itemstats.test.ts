import { describe, expect, it } from "vitest";
import {
  computeItemStats,
  discriminationBandFor,
  observedDifficultyFor,
  GROUP_FRACTION,
  MIN_RESPONSES,
  type ItemResponse,
  type OptionInput,
} from "@/core/itemstats/compute";

/**
 * Every number below is worked out by hand in the comment above it.
 *
 * A self-consistent test — one that computes the expectation with the same
 * arithmetic as the implementation — proves the code does what the code does.
 * These pin the maths to values a person can check on paper, which is the only
 * kind of test worth having on a statistics module: the failure this guards
 * against is the formula being wrong, not the loop.
 */

const options: OptionInput[] = [
  { key: "A", text: "AA", isCorrect: true },
  { key: "B", text: "SSS", isCorrect: false },
  { key: "C", text: "SAS", isCorrect: false },
  { key: "D", text: "ASA", isCorrect: false },
];

/**
 * Builds `n` responses from a spec of `[itemScore, restScore, chosenKey]`.
 *
 * `totalScore` is derived so the ranking is by the whole paper, exactly as the
 * reader supplies it: a nine-item rest at `rest` plus this one item at `score`,
 * out of ten equal marks.
 */
function make(
  rows: [score: number, rest: number, key?: string][],
): ItemResponse[] {
  return rows.map(([score, rest, key], index) => ({
    // Zero-padded so the id tiebreak sorts the way a reader would expect.
    id: `r${String(index).padStart(3, "0")}`,
    score,
    totalScore: (score + rest * 9) / 10,
    restScore: rest,
    chosenKeys: key === undefined ? null : [key],
  }));
}

/** 30 responses: the first `right` score 1, the rest 0. */
function split(right: number, total = 30): ItemResponse[] {
  return make(
    Array.from({ length: total }, (_, index) =>
      index < right
        ? ([1, 0.9] as [number, number])
        : ([0, 0.3] as [number, number]),
    ),
  );
}

describe("the refusal", () => {
  it("gives no number at all below the threshold, and says how far off it is", () => {
    const stats = computeItemStats(split(20, 29), "MEDIUM", null);

    expect(stats.enough).toBe(false);
    if (stats.enough) throw new Error("unreachable");
    expect(stats.responses).toBe(29);
    expect(stats.needed).toBe(MIN_RESPONSES);
    expect(stats.reason).toBe("too-few-responses");
    // The declared difficulty survives the refusal — it is the teacher's own
    // judgement, not something the data was asked about.
    expect(stats.declaredDifficulty).toBe("MEDIUM");
    // No provisional figure hiding on the object for a component to reach for.
    expect("pValue" in stats).toBe(false);
    expect("discrimination" in stats).toBe(false);
  });

  it("separates nothing-yet from not-enough-yet", () => {
    const stats = computeItemStats([], "HARD", null);
    expect(stats.enough).toBe(false);
    if (stats.enough) throw new Error("unreachable");
    expect(stats.reason).toBe("no-responses");
    expect(stats.responses).toBe(0);
  });

  it("computes at exactly the threshold, not one above it", () => {
    expect(computeItemStats(split(15, 30), "MEDIUM", null).enough).toBe(true);
  });
});

describe("the p-value", () => {
  it("is the proportion who got it right", () => {
    // 21 of 30 correct: 21 / 30 = 0.7.
    const stats = computeItemStats(split(21), "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");
    expect(stats.pValue).toBe(0.7);
  });

  it("counts partial credit as the fraction of marks earned", () => {
    // 30 responses, every one scoring 0.5 of a three-mark question.
    // Mean = 0.5 exactly, which no count of right-and-wrong could produce.
    const rows = make(
      Array.from({ length: 30 }, () => [0.5, 0.5] as [number, number]),
    );
    const stats = computeItemStats(rows, "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");
    expect(stats.pValue).toBe(0.5);
  });

  it("reads HIGH as EASY, which is the way round nobody expects", () => {
    // The name is backwards: a high p-value means most of the cohort got it.
    expect(observedDifficultyFor(0.91)).toBe("EASY");
    expect(observedDifficultyFor(0.7)).toBe("EASY");
    expect(observedDifficultyFor(0.69)).toBe("MEDIUM");
    expect(observedDifficultyFor(0.4)).toBe("MEDIUM");
    expect(observedDifficultyFor(0.39)).toBe("HARD");
    expect(observedDifficultyFor(0)).toBe("HARD");
  });
});

describe("observed difficulty beside declared difficulty", () => {
  it("flags a disagreement and never replaces the teacher's judgement", () => {
    // 27 of 30 right: p = 0.9, which is EASY. The teacher said HARD.
    const stats = computeItemStats(split(27), "HARD", null);
    if (!stats.enough) throw new Error("expected enough");

    expect(stats.pValue).toBe(0.9);
    expect(stats.observedDifficulty).toBe("EASY");
    // Still HARD. The whole point: this module reports, it does not correct.
    expect(stats.declaredDifficulty).toBe("HARD");
    expect(stats.difficultyDisagrees).toBe(true);
  });

  it("agrees quietly when it agrees", () => {
    // 15 of 30: p = 0.5, MEDIUM, and MEDIUM was declared.
    const stats = computeItemStats(split(15), "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");
    expect(stats.pValue).toBe(0.5);
    expect(stats.observedDifficulty).toBe("MEDIUM");
    expect(stats.difficultyDisagrees).toBe(false);
  });
});

describe("the discrimination index", () => {
  it("splits at 27% and subtracts the weak group from the strong one", () => {
    // 30 responses. round(30 * 0.27) = round(8.1) = 8 in each group.
    //
    // Ranked by total score: the 18 who got the item right have
    // (1 + 0.9 * 9) / 10 = 0.91; the 12 who got it wrong have
    // (0 + 0.3 * 9) / 10 = 0.27. So the upper 8 are all correct and the
    // lower 8 are all wrong.
    //   upper mean = 8/8 = 1
    //   lower mean = 0/8 = 0
    //   D = 1 - 0 = 1, a perfectly discriminating item.
    const stats = computeItemStats(split(18), "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");

    expect(stats.groupSize).toBe(8);
    expect(Math.round(30 * GROUP_FRACTION)).toBe(8);
    expect(stats.upperMean).toBe(1);
    expect(stats.lowerMean).toBe(0);
    expect(stats.discrimination).toBe(1);
    expect(stats.discriminationBand).toBe("EXCELLENT");
    expect(stats.keySuspect).toBe(false);
  });

  it("goes NEGATIVE when the strongest students get it wrong — the loud one", () => {
    // 30 responses, deliberately inverted: the 10 students with the BEST rest
    // of the paper (rest = 0.9) all got this item wrong; the 20 with the worst
    // (rest = 0.2) all got it right.
    //
    // Total scores: strong-but-wrong = (0 + 0.9 * 9) / 10 = 0.81;
    //               weak-but-right    = (1 + 0.2 * 9) / 10 = 0.28.
    // So the upper 8 by total score are all from the wrong group and the
    // lower 8 are all from the right group.
    //   upper mean = 0, lower mean = 1, D = -1.
    const rows = make([
      ...Array.from({ length: 10 }, () => [0, 0.9] as [number, number]),
      ...Array.from({ length: 20 }, () => [1, 0.2] as [number, number]),
    ]);
    const stats = computeItemStats(rows, "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");

    expect(stats.discrimination).toBe(-1);
    expect(stats.discriminationBand).toBe("NEGATIVE");
    // The flag the page shouts with. A negative discrimination almost always
    // means the answer key is wrong, and until somebody looks, every student
    // who knew the material is being marked down for knowing it.
    expect(stats.keySuspect).toBe(true);
  });

  it("uses the documented Ebel bands, with NEGATIVE separated from POOR", () => {
    expect(discriminationBandFor(0.45)).toBe("EXCELLENT");
    expect(discriminationBandFor(0.4)).toBe("EXCELLENT");
    expect(discriminationBandFor(0.39)).toBe("GOOD");
    expect(discriminationBandFor(0.3)).toBe("GOOD");
    expect(discriminationBandFor(0.29)).toBe("FAIR");
    expect(discriminationBandFor(0.2)).toBe("FAIR");
    expect(discriminationBandFor(0.19)).toBe("POOR");
    expect(discriminationBandFor(0)).toBe("POOR");
    // Both are bad; only one means the item is marking the wrong people down.
    expect(discriminationBandFor(-0.01)).toBe("NEGATIVE");
  });

  it("does not move when tied totals arrive in a different order", () => {
    // Every response has the same total score, so the ranking is entirely
    // ties — the case where a database's row order would otherwise decide the
    // figure. Shuffled input, identical output, because ties break on id.
    const rows = make(
      Array.from(
        { length: 30 },
        (_, index) => [index % 2 === 0 ? 1 : 0, 0.5] as [number, number],
      ),
    );
    const shuffled = [...rows].reverse();

    const a = computeItemStats(rows, "MEDIUM", null);
    const b = computeItemStats(shuffled, "MEDIUM", null);
    if (!a.enough || !b.enough) throw new Error("expected enough");
    expect(b.discrimination).toBe(a.discrimination);
    expect(b.upperMean).toBe(a.upperMean);
  });
});

describe("the point-biserial correlation", () => {
  it("matches a correlation worked out by hand", () => {
    // A deliberately small, fully hand-checkable case, padded to the threshold
    // with 26 identical middle responses so the arithmetic stays doable.
    //
    // 30 responses:
    //   2 with score 1, rest 1
    //   2 with score 0, rest 0
    //   26 with score 0.5, rest 0.5
    //
    // mean(x) = mean(y) = (2*1 + 2*0 + 26*0.5) / 30 = 15 / 30 = 0.5.
    // Every deviation is identical in x and y, so cov = varX = varY and
    // r = 1 exactly: a perfectly discriminating item.
    const rows = make([
      ...Array.from({ length: 2 }, () => [1, 1] as [number, number]),
      ...Array.from({ length: 2 }, () => [0, 0] as [number, number]),
      ...Array.from({ length: 26 }, () => [0.5, 0.5] as [number, number]),
    ]);
    const stats = computeItemStats(rows, "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");
    expect(stats.pointBiserial).toBe(1);
  });

  it("is exactly -1 when the item runs against the rest of the paper", () => {
    // The mirror of the case above: x = 1 - y throughout.
    const rows = make([
      ...Array.from({ length: 2 }, () => [1, 0] as [number, number]),
      ...Array.from({ length: 2 }, () => [0, 1] as [number, number]),
      ...Array.from({ length: 26 }, () => [0.5, 0.5] as [number, number]),
    ]);
    const stats = computeItemStats(rows, "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");
    expect(stats.pointBiserial).toBe(-1);
  });

  it("matches a hand-computed value that is not a round number", () => {
    // 30 responses. 15 pairs of (x, y):
    //   10 at (1, 0.8), 5 at (1, 0.4), 5 at (0, 0.8), 10 at (0, 0.4)
    //
    // mean(x) = 15/30 = 0.5
    // mean(y) = (15 * 0.8 + 15 * 0.4) / 30 = 18 / 30 = 0.6
    //
    // dx is +/- 0.5 and dy is +/- 0.2 throughout.
    //   cov = 10(0.5)(0.2) + 5(0.5)(-0.2) + 5(-0.5)(0.2) + 10(-0.5)(-0.2)
    //       = 1 - 0.5 - 0.5 + 1 = 1
    //   varX = 30 * 0.25 = 7.5
    //   varY = 30 * 0.04 = 1.2
    //   r = 1 / sqrt(7.5 * 1.2) = 1 / sqrt(9) = 1/3 = 0.333...
    const rows = make([
      ...Array.from({ length: 10 }, () => [1, 0.8] as [number, number]),
      ...Array.from({ length: 5 }, () => [1, 0.4] as [number, number]),
      ...Array.from({ length: 5 }, () => [0, 0.8] as [number, number]),
      ...Array.from({ length: 10 }, () => [0, 0.4] as [number, number]),
    ]);
    const stats = computeItemStats(rows, "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");
    expect(stats.pointBiserial).toBe(0.333);
  });

  it("is null rather than zero when everybody scored the same", () => {
    // No variance on the item. Zero would read as "no relationship"; the truth
    // is that no question was asked.
    const rows = make(
      Array.from({ length: 30 }, (_, index) => [
        1,
        index / 100,
      ] as [number, number]),
    );
    const stats = computeItemStats(rows, "EASY", null);
    if (!stats.enough) throw new Error("expected enough");
    expect(stats.pointBiserial).toBeNull();
  });

  it("is null on a one-item paper, where there is no rest to correlate with", () => {
    const rows: ItemResponse[] = split(15).map((row) => ({
      ...row,
      restScore: null,
    }));
    const stats = computeItemStats(rows, "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");
    expect(stats.pointBiserial).toBeNull();
    // Everything else still computes — one missing figure is not a refusal.
    expect(stats.pValue).toBe(0.5);
  });
});

describe("the options", () => {
  it("counts every option, and names the one nobody ever picks", () => {
    // 30 responses: 18 chose A (the key), 8 chose B, 4 chose C, 0 chose D.
    const rows = make([
      ...Array.from({ length: 18 }, () => [1, 0.8, "A"] as [number, number, string]),
      ...Array.from({ length: 8 }, () => [0, 0.4, "B"] as [number, number, string]),
      ...Array.from({ length: 4 }, () => [0, 0.3, "C"] as [number, number, string]),
    ]);
    const stats = computeItemStats(rows, "MEDIUM", options);
    if (!stats.enough) throw new Error("expected enough");

    const byKey = Object.fromEntries(
      (stats.options ?? []).map((option) => [option.key, option]),
    );
    expect(byKey.A!.chosen).toBe(18);
    expect(byKey.A!.share).toBe(0.6);
    expect(byKey.B!.chosen).toBe(8);
    expect(byKey.C!.chosen).toBe(4);
    // A distractor nobody chooses is doing no work: this is a three-option
    // question wearing four options.
    expect(byKey.D!.chosen).toBe(0);
    expect(byKey.D!.dead).toBe(true);
    expect(byKey.A!.dead).toBe(false);
    expect(stats.keySuspect).toBe(false);
  });

  it("flags a distractor that beat the key", () => {
    // 20 chose B, 10 chose A. A is the key. Either a real misconception worth
    // teaching to, or — far more often — a mis-keyed question.
    const rows = make([
      ...Array.from({ length: 20 }, () => [0, 0.6, "B"] as [number, number, string]),
      ...Array.from({ length: 10 }, () => [1, 0.5, "A"] as [number, number, string]),
    ]);
    const stats = computeItemStats(rows, "MEDIUM", options);
    if (!stats.enough) throw new Error("expected enough");

    const b = (stats.options ?? []).find((option) => option.key === "B");
    expect(b?.outperformsKey).toBe(true);
    expect(stats.keySuspect).toBe(true);
    // The key itself is never reported as outperforming itself.
    const a = (stats.options ?? []).find((option) => option.key === "A");
    expect(a?.outperformsKey).toBe(false);
  });

  it("splits each option's takers into the strong and weak groups", () => {
    // 30 responses, groups of 8. The 15 strongest (rest 0.9, item right,
    // total 0.91) chose A; the 15 weakest (rest 0.2, item wrong, total 0.18)
    // chose B. So the upper 8 all chose A and the lower 8 all chose B.
    const rows = make([
      ...Array.from({ length: 15 }, () => [1, 0.9, "A"] as [number, number, string]),
      ...Array.from({ length: 15 }, () => [0, 0.2, "B"] as [number, number, string]),
    ]);
    const stats = computeItemStats(rows, "MEDIUM", options);
    if (!stats.enough) throw new Error("expected enough");

    const byKey = Object.fromEntries(
      (stats.options ?? []).map((option) => [option.key, option]),
    );
    expect(byKey.A!.upperChosen).toBe(8);
    expect(byKey.A!.lowerChosen).toBe(0);
    expect(byKey.B!.upperChosen).toBe(0);
    expect(byKey.B!.lowerChosen).toBe(8);
  });

  it("reports no options at all for a type that has none", () => {
    const stats = computeItemStats(split(15), "MEDIUM", null);
    if (!stats.enough) throw new Error("expected enough");
    expect(stats.options).toBeNull();
    expect(stats.keySuspect).toBe(false);
  });
});
