import { describe, expect, it } from "vitest";
import {
  bandFor,
  displayableEstimate,
  estimateMastery,
  trendFor,
  HALF_LIFE_DAYS,
  MIN_EVIDENCE,
  type Evidence,
} from "@/core/mastery/estimate";

const NOW = new Date("2026-09-08T09:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function evidence(
  count: number,
  score: number,
  overrides: Partial<Evidence> = {},
): Evidence[] {
  return Array.from({ length: count }, () => ({
    score,
    difficulty: "MEDIUM" as const,
    mapping: 1,
    observedAt: daysAgo(1),
    ...overrides,
  }));
}

describe("the refusal rule", () => {
  it("returns no number at all when there is no evidence", () => {
    const mastery = estimateMastery([], NOW);
    expect(mastery.band).toBe("INSUFFICIENT");
    // Not zero, not 0.5, not the prior. A mastery figure the product cannot
    // stand behind is worse than a blank, because a teacher will schedule a
    // remedial class on it.
    expect(displayableEstimate(mastery)).toBeNull();
    expect(mastery.evidenceCount).toBe(0);
  });

  it("refuses below the minimum number of answers", () => {
    const mastery = estimateMastery(evidence(MIN_EVIDENCE - 1, 1), NOW);
    expect(mastery.band).toBe("INSUFFICIENT");
    expect(displayableEstimate(mastery)).toBeNull();
    if (mastery.band !== "INSUFFICIENT") return;
    expect(mastery.reason).toBe("too-few-answers");
  });

  it("gives a number once there is enough", () => {
    const mastery = estimateMastery(evidence(MIN_EVIDENCE, 1), NOW);
    expect(mastery.band).not.toBe("INSUFFICIENT");
    expect(displayableEstimate(mastery)).toBeGreaterThan(0.5);
  });

  it("refuses when all the evidence has decayed away", () => {
    // Six answers, all from two years ago. The raw count passes; what they say
    // about this student now does not.
    const mastery = estimateMastery(
      evidence(6, 1, { observedAt: daysAgo(730) }),
      NOW,
    );
    expect(mastery.band).toBe("INSUFFICIENT");
    if (mastery.band !== "INSUFFICIENT") return;
    expect(mastery.reason).toBe("evidence-too-old");
    // The count is still reported honestly — there IS evidence, it is just old.
    expect(mastery.evidenceCount).toBe(6);
    expect(mastery.effectiveEvidence).toBeLessThan(1);
  });

  it("names which refusal it is", () => {
    const reasons = [
      estimateMastery([], NOW),
      estimateMastery(evidence(2, 1), NOW),
      estimateMastery(evidence(6, 1, { observedAt: daysAgo(900) }), NOW),
    ].map((m) => (m.band === "INSUFFICIENT" ? m.reason : null));

    // "Nobody has answered anything", "not enough yet" and "this is all old"
    // are three different things to do something about.
    expect(reasons).toEqual(["no-evidence", "too-few-answers", "evidence-too-old"]);
  });
});

describe("the estimate", () => {
  it("is not correct-over-attempted", () => {
    // Four out of four correct. A ratio would say 1.0 — a claim of certainty
    // off four answers. The posterior mean is high and honest instead.
    const mastery = estimateMastery(evidence(4, 1), NOW);
    if (mastery.band === "INSUFFICIENT") throw new Error("expected a number");
    expect(mastery.estimate).toBeLessThan(1);
    expect(mastery.estimate).toBeGreaterThan(0.7);
  });

  it("is more confident about thirty answers than about four", () => {
    const few = estimateMastery(evidence(4, 1), NOW);
    const many = estimateMastery(evidence(30, 1), NOW);
    if (few.band === "INSUFFICIENT" || many.band === "INSUFFICIENT") {
      throw new Error("expected numbers");
    }
    // The same 0.8 from four answers and from thirty is a different claim, and
    // the difference is exactly what the confidence carries.
    expect(many.confidence).toBeGreaterThan(few.confidence);
    expect(many.estimate).toBeGreaterThan(few.estimate);
  });

  it("moves further on a hard question answered correctly", () => {
    const easy = estimateMastery(evidence(6, 1, { difficulty: "EASY" }), NOW);
    const hard = estimateMastery(evidence(6, 1, { difficulty: "HARD" }), NOW);
    if (easy.band === "INSUFFICIENT" || hard.band === "INSUFFICIENT") {
      throw new Error("expected numbers");
    }
    expect(hard.estimate).toBeGreaterThan(easy.estimate);
  });

  it("punishes an easy question answered wrongly harder than a hard one", () => {
    const easy = estimateMastery(evidence(6, 0, { difficulty: "EASY" }), NOW);
    const hard = estimateMastery(evidence(6, 0, { difficulty: "HARD" }), NOW);
    if (easy.band === "INSUFFICIENT" || hard.band === "INSUFFICIENT") {
      throw new Error("expected numbers");
    }
    // Getting an EASY item wrong is the most informative thing a student can
    // do. A model that only rewarded hard correct answers would let somebody
    // fail every easy question and still look fine.
    expect(easy.estimate).toBeLessThan(hard.estimate);
  });

  it("weights recent evidence above old evidence", () => {
    const mixed = estimateMastery(
      [
        ...evidence(5, 0, { observedAt: daysAgo(HALF_LIFE_DAYS * 4) }),
        ...evidence(5, 1, { observedAt: daysAgo(1) }),
      ],
      NOW,
    );
    if (mixed.band === "INSUFFICIENT") throw new Error("expected a number");
    // Five wrong long ago and five right this week is a student who has
    // learned it. An unweighted average would call that a coin flip.
    expect(mixed.estimate).toBeGreaterThan(0.6);
  });

  it("halves the weight of evidence one half-life old", () => {
    const fresh = estimateMastery(evidence(8, 1, { observedAt: daysAgo(0) }), NOW);
    const aged = estimateMastery(
      evidence(8, 1, { observedAt: daysAgo(HALF_LIFE_DAYS) }),
      NOW,
    );
    if (fresh.band === "INSUFFICIENT" || aged.band === "INSUFFICIENT") {
      throw new Error("expected numbers");
    }
    expect(aged.effectiveEvidence).toBeCloseTo(fresh.effectiveEvidence / 2, 2);
  });

  it("counts partial credit as partial, not as right or wrong", () => {
    const partial = estimateMastery(evidence(8, 0.5), NOW);
    const right = estimateMastery(evidence(8, 1), NOW);
    const wrong = estimateMastery(evidence(8, 0), NOW);
    if (
      partial.band === "INSUFFICIENT" ||
      right.band === "INSUFFICIENT" ||
      wrong.band === "INSUFFICIENT"
    ) {
      throw new Error("expected numbers");
    }
    // Two marks out of three is neither right nor wrong. Rounding it either
    // way at the ledger throws away the difference for good.
    expect(partial.estimate).toBeLessThan(right.estimate);
    expect(partial.estimate).toBeGreaterThan(wrong.estimate);
    expect(partial.estimate).toBeCloseTo(0.5, 1);
  });

  it("moves less on a question that only touches the concept", () => {
    const primary = estimateMastery(evidence(8, 1, { mapping: 1 }), NOW);
    const secondary = estimateMastery(evidence(8, 1, { mapping: 0.4 }), NOW);
    if (primary.band === "INSUFFICIENT" || secondary.band === "INSUFFICIENT") {
      throw new Error("expected numbers");
    }
    expect(secondary.estimate).toBeLessThan(primary.estimate);
    expect(secondary.effectiveEvidence).toBeLessThan(primary.effectiveEvidence);
  });

  it("reports the most recent evidence, not the first", () => {
    const mastery = estimateMastery(
      [
        ...evidence(3, 1, { observedAt: daysAgo(30) }),
        ...evidence(3, 1, { observedAt: daysAgo(2) }),
      ],
      NOW,
    );
    expect(mastery.lastEvidenceAt?.getTime()).toBe(daysAgo(2).getTime());
  });

  it("never returns an estimate outside 0 and 1", () => {
    for (const score of [-5, 0, 0.3, 1, 7]) {
      for (const mapping of [-1, 0, 0.5, 1, 3]) {
        const mastery = estimateMastery(evidence(10, score, { mapping }), NOW);
        if (mastery.band === "INSUFFICIENT") continue;
        expect(mastery.estimate).toBeGreaterThanOrEqual(0);
        expect(mastery.estimate).toBeLessThanOrEqual(1);
        expect(mastery.confidence).toBeGreaterThanOrEqual(0);
        expect(mastery.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("the bands", () => {
  it("matches the reserved scale", () => {
    // DESIGN_SYSTEM.md section 2.4. These are the boundaries the colour tokens
    // are named for; changing one here changes what a colour means.
    expect(bandFor(0.95)).toBe("SECURE");
    expect(bandFor(0.8)).toBe("SECURE");
    expect(bandFor(0.79)).toBe("DEVELOPING");
    expect(bandFor(0.6)).toBe("DEVELOPING");
    expect(bandFor(0.59)).toBe("FRAGILE");
    expect(bandFor(0.4)).toBe("FRAGILE");
    expect(bandFor(0.39)).toBe("CRITICAL");
    expect(bandFor(0)).toBe("CRITICAL");
  });

  it("puts a student who gets everything wrong in CRITICAL", () => {
    const mastery = estimateMastery(evidence(10, 0), NOW);
    expect(mastery.band).toBe("CRITICAL");
  });

  it("puts a student who gets everything right in SECURE", () => {
    const mastery = estimateMastery(evidence(10, 1), NOW);
    expect(mastery.band).toBe("SECURE");
  });
});

describe("the trend", () => {
  it("is unknown without a previous estimate", () => {
    expect(trendFor(0.7, null)).toBe("UNKNOWN");
    expect(trendFor(null, 0.7)).toBe("UNKNOWN");
  });

  it("ignores movement inside the noise threshold", () => {
    // Mastery wobbles a point or two on every answer. An arrow that flips on
    // that noise trains a teacher to ignore it.
    expect(trendFor(0.72, 0.7)).toBe("STABLE");
    expect(trendFor(0.68, 0.7)).toBe("STABLE");
  });

  it("names real movement in both directions", () => {
    expect(trendFor(0.8, 0.7)).toBe("IMPROVING");
    expect(trendFor(0.6, 0.7)).toBe("DECLINING");
  });
});
