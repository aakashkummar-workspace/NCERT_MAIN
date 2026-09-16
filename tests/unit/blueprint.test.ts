import { describe, expect, it } from "vitest";
import {
  allocate,
  describeShortfalls,
  planSlots,
  validateBlueprint,
  type BankInventory,
  type Blueprint,
} from "@/core/assessments/blueprint";

const base: Blueprint = {
  totalQuestions: 10,
  totalMarks: 10,
  difficultyMix: { EASY: 30, MEDIUM: 50, HARD: 20 },
  typeMix: { MCQ: 100 },
  outcomeIds: ["outcome-1"],
};

const errorsOf = (blueprint: Blueprint) =>
  validateBlueprint(blueprint).filter((p) => p.severity === "error");

describe("validateBlueprint", () => {
  it("accepts a sensible plan", () => {
    expect(validateBlueprint(base)).toEqual([]);
  });

  it("catches a difficulty split that does not add up", () => {
    const problems = errorsOf({
      ...base,
      difficultyMix: { EASY: 30, MEDIUM: 50, HARD: 30 },
    });
    expect(problems[0]?.message).toMatch(/110%/);
  });

  it("catches a type split that does not add up", () => {
    const problems = errorsOf({ ...base, typeMix: { MCQ: 60, SA: 30 } });
    expect(problems[0]?.message).toMatch(/90%/);
  });

  it("catches no question type chosen at all", () => {
    expect(errorsOf({ ...base, typeMix: {} })).toHaveLength(1);
  });

  it("catches marks that cannot be reached with whole-mark questions", () => {
    // 20 questions cannot total 10 marks — every question is worth at least 1.
    const problems = errorsOf({ ...base, totalQuestions: 20, totalMarks: 10 });
    expect(problems[0]?.message).toMatch(/at least 1/);
  });

  it("accepts marks above the question count", () => {
    expect(errorsOf({ ...base, totalQuestions: 10, totalMarks: 40 })).toEqual([]);
  });

  it("rejects impossible sizes", () => {
    expect(errorsOf({ ...base, totalQuestions: 0 })).not.toEqual([]);
    expect(errorsOf({ ...base, totalQuestions: 500 })).not.toEqual([]);
    expect(errorsOf({ ...base, totalMarks: 0 })).not.toEqual([]);
  });

  it("warns, but does not block, when no outcome is in scope", () => {
    // A mixed revision paper is legitimate. It just cannot report mastery.
    const problems = validateBlueprint({ ...base, outcomeIds: [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe("warning");
    expect(problems[0]?.message).toMatch(/which concepts/);
  });
});

describe("allocate", () => {
  it("splits evenly when the numbers divide", () => {
    expect(allocate(10, { EASY: 30, MEDIUM: 50, HARD: 20 })).toEqual({
      EASY: 3,
      MEDIUM: 5,
      HARD: 2,
    });
  });

  it("never loses a question to rounding", () => {
    // The property that matters: a blueprint promising 7 questions must
    // allocate 7, whatever the percentages do.
    for (const total of [1, 3, 7, 11, 13, 17, 23, 41]) {
      const counts = allocate(total, { EASY: 30, MEDIUM: 50, HARD: 20 });
      const allocated = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(allocated, `total ${total}`).toBe(total);
    }
  });

  it("gives the remainder to the largest shares first", () => {
    // 7 × 30/50/20 is 2.1 / 3.5 / 1.4 — the spare question goes to MEDIUM.
    expect(allocate(7, { EASY: 30, MEDIUM: 50, HARD: 20 })).toEqual({
      EASY: 2,
      MEDIUM: 4,
      HARD: 1,
    });
  });

  it("ignores zero shares", () => {
    expect(allocate(10, { EASY: 0, MEDIUM: 100, HARD: 0 })).toEqual({ MEDIUM: 10 });
  });

  it("returns nothing for a zero total", () => {
    expect(allocate(0, { MCQ: 100 })).toEqual({});
  });
});

describe("planSlots", () => {
  const stocked: BankInventory[] = [
    { difficulty: "EASY", type: "MCQ", count: 10 },
    { difficulty: "MEDIUM", type: "MCQ", count: 10 },
    { difficulty: "HARD", type: "MCQ", count: 10 },
  ];

  it("is feasible when the bank holds enough", () => {
    const result = planSlots(base, stocked);
    expect(result.feasible).toBe(true);
    expect(result.wanted).toBe(10);
    expect(result.supplied).toBe(10);
    expect(result.shortfalls).toEqual([]);
  });

  it("reports the exact shortfall rather than truncating silently", () => {
    // A blueprint that quietly returns fewer questions than promised is worse
    // than one that says so.
    const result = planSlots(base, [
      { difficulty: "EASY", type: "MCQ", count: 10 },
      { difficulty: "MEDIUM", type: "MCQ", count: 10 },
      { difficulty: "HARD", type: "MCQ", count: 1 },
    ]);
    expect(result.feasible).toBe(false);
    expect(result.shortfalls).toHaveLength(1);
    expect(result.shortfalls[0]).toMatchObject({
      difficulty: "HARD",
      wanted: 2,
      available: 1,
    });
    expect(result.supplied).toBe(9);
  });

  it("reports an empty bank as a shortfall, not a crash", () => {
    const result = planSlots(base, []);
    expect(result.feasible).toBe(false);
    expect(result.supplied).toBe(0);
    expect(result.shortfalls).toHaveLength(3);
  });

  it("splits across types as well as difficulties", () => {
    const result = planSlots(
      { ...base, totalQuestions: 10, typeMix: { MCQ: 50, SA: 50 } },
      [
        { difficulty: "MEDIUM", type: "MCQ", count: 5 },
        { difficulty: "MEDIUM", type: "SA", count: 5 },
        { difficulty: "EASY", type: "MCQ", count: 5 },
        { difficulty: "EASY", type: "SA", count: 5 },
        { difficulty: "HARD", type: "MCQ", count: 5 },
        { difficulty: "HARD", type: "SA", count: 5 },
      ],
    );
    expect(result.wanted).toBe(10);
    expect(result.feasible).toBe(true);
    expect(result.slots.length).toBeGreaterThan(3);
  });
});

describe("describeShortfalls", () => {
  it("names the gap and both ways out of it", () => {
    const result = planSlots(base, [
      { difficulty: "EASY", type: "MCQ", count: 10 },
      { difficulty: "MEDIUM", type: "MCQ", count: 10 },
      { difficulty: "HARD", type: "MCQ", count: 1 },
    ]);
    const lines = describeShortfalls(result);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/asked for 2 hard multiple-choice questions/);
    expect(lines[0]).toMatch(/has 1/);
    expect(lines[0]).toMatch(/Write 1 more, or change the mix/);
  });

  it("says so plainly when the bank has none of that kind", () => {
    const result = planSlots(base, [
      { difficulty: "EASY", type: "MCQ", count: 10 },
      { difficulty: "MEDIUM", type: "MCQ", count: 10 },
    ]);
    expect(describeShortfalls(result)[0]).toMatch(/has none in this scope/);
  });

  it("says nothing when the plan is feasible", () => {
    const result = planSlots(base, [
      { difficulty: "EASY", type: "MCQ", count: 10 },
      { difficulty: "MEDIUM", type: "MCQ", count: 10 },
      { difficulty: "HARD", type: "MCQ", count: 10 },
    ]);
    expect(describeShortfalls(result)).toEqual([]);
  });
});
