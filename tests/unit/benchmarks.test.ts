import { describe, expect, it } from "vitest";
import {
  compare,
  HARD_EVERYWHERE_AT,
  MATERIAL_GAP,
  median,
  MIN_SCHOOLS,
  quantile,
  type Benchmark,
} from "@/core/benchmarks/compare";

/**
 * The cross-school comparison.
 *
 * Every claim here is about what the sentence must NOT contain. This is the
 * feature most easily built into a lie: a median across schools is one small
 * step from a position among schools, and a position is a league table with
 * better manners.
 */

const bench = (over: Partial<Benchmark> = {}): Benchmark => ({
  schools: over.schools ?? 7,
  students: over.students ?? 210,
  median: over.median ?? 0.72,
  p25: over.p25 ?? 0.64,
  p75: over.p75 ?? 0.8,
});

describe("it compares the idea, not the schools", () => {
  it("calls a low median a hard idea rather than a gap in this class", () => {
    // Everybody at 0.5 says the idea is hard, or is taught too early. Telling
    // this teacher to reteach would cost a lesson to fix somebody else's
    // syllabus.
    const result = compare(0.48, bench({ median: 0.5, p25: 0.44, p75: 0.58 }), "Ratio");
    expect(result.verdict).toBe("hard-everywhere");
    expect(result.sentence).toMatch(/hard idea rather than a gap/i);
  });

  it("calls a class behind only when the median is healthy", () => {
    const result = compare(0.45, bench({ median: 0.72 }), "Ratio");
    expect(result.verdict).toBe("behind");
    expect(result.sentence).toMatch(/points at this class rather than at the idea/i);
  });

  it("treats a gap smaller than the noise floor as in line", () => {
    const result = compare(0.72 - MATERIAL_GAP / 2, bench({ median: 0.72 }), "Ratio");
    expect(result.verdict).toBe("in-line");
  });

  it("says so plainly when a class is above the middle", () => {
    expect(compare(0.9, bench({ median: 0.72 }), "Ratio").verdict).toBe("ahead");
  });

  it("gives the shared figure even when this class has nothing measured", () => {
    // The class read refuses below its own threshold, which is a normal state.
    // The median is still worth knowing before teaching the thing.
    const result = compare(null, bench(), "Ratio");
    expect(result.sentence).toMatch(/not enough measured here yet/i);
  });

  it("puts the boundary where the constant says", () => {
    const at = compare(
      HARD_EVERYWHERE_AT,
      bench({ median: HARD_EVERYWHERE_AT }),
      "Ratio",
    );
    expect(at.verdict).toBe("hard-everywhere");
    const above = compare(0.75, bench({ median: HARD_EVERYWHERE_AT + 0.01 }), "Ratio");
    expect(above.verdict).toBe("ahead");
  });
});

describe("no school is identifiable, including by elimination", () => {
  const sentences = [
    compare(0.45, bench({ median: 0.72 }), "Ratio").sentence,
    compare(0.9, bench({ median: 0.72 }), "Ratio").sentence,
    compare(0.48, bench({ median: 0.5 }), "Ratio").sentence,
    compare(null, bench(), "Ratio").sentence,
  ];

  it("never ranks, positions or names a peer", () => {
    for (const sentence of sentences) {
      // The standing grep. A rank is a league table with better manners, and
      // "3rd of 5" identifies two schools by elimination the moment somebody
      // compares notes.
      for (const forbidden of [
        /\brank/i,
        /\bleague/i,
        /\bpercentile\b/i,
        /\btop\b/i,
        /\bbottom\b/i,
        /\bbest\b/i,
        /\bworst\b/i,
        /\d+(st|nd|rd|th) of \d+/i,
        /\bschool [A-Z]\b/,
      ]) {
        expect(sentence).not.toMatch(forbidden);
      }
    }
  });

  it("carries a count of schools and a spread, and nothing else about them", () => {
    const { sentence } = compare(0.45, bench({ schools: 7, median: 0.72 }), "Ratio");
    expect(sentence).toMatch(/Across 7 schools/);
    expect(sentence).toMatch(/most between 64% and 80%/);
  });

  it("returns a shape with no field a school could be put in", () => {
    const result = compare(0.45, bench(), "Ratio");
    expect(Object.keys(result).sort()).toEqual(["benchmark", "sentence", "verdict"]);
    expect(Object.keys(result.benchmark).sort()).toEqual([
      "median",
      "p25",
      "p75",
      "schools",
      "students",
    ]);
  });
});

describe("the floor is on schools", () => {
  it("is five, and is a floor on schools rather than on students", () => {
    // Stated as a test because the number is the feature: with two
    // contributors, each can derive the other's figure from the median and its
    // own. A student floor would not fix that — two schools of four hundred
    // are still two schools.
    expect(MIN_SCHOOLS).toBeGreaterThanOrEqual(5);
  });
});

describe("the median matches what the database computes", () => {
  it("interpolates an even-length list, as percentile_cont does", () => {
    expect(median([0.2, 0.4, 0.6, 0.8])).toBeCloseTo(0.5, 10);
    expect(median([0.1, 0.5, 0.9])).toBeCloseTo(0.5, 10);
  });

  it("gives each school one vote regardless of its size", () => {
    // The median of five school means. A school with six hundred students
    // counts once, exactly as the batch mean gives each student one vote.
    expect(median([0.9, 0.2, 0.5, 0.4, 0.6])).toBeCloseTo(0.5, 10);
  });

  it("quantiles the way percentile_cont does", () => {
    expect(quantile([0.2, 0.4, 0.6, 0.8], 0.25)).toBeCloseTo(0.35, 10);
    expect(quantile([0.2, 0.4, 0.6, 0.8], 0.75)).toBeCloseTo(0.65, 10);
  });

  it("refuses an empty list rather than returning a zero", () => {
    expect(median([])).toBeNull();
    expect(quantile([], 0.5)).toBeNull();
  });
});
