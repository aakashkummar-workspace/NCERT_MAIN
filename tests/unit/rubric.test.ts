import { describe, expect, it } from "vitest";
import {
  MAX_CRITERIA,
  parseRubric,
  totalFor,
  validateRubric,
  validateScores,
  type Rubric,
} from "@/core/questions/rubric";

const rubric = (
  ...criteria: { id: string; label: string; marks: number }[]
): Rubric => ({ criteria });

const THREE_MARK = rubric(
  { id: "method", label: "Method", marks: 2 },
  { id: "answer", label: "Final answer", marks: 1 },
);

describe("a mark scheme must be able to award full marks", () => {
  it("refuses one that adds up to less than the question", () => {
    // The invariant. Discovered at the twentieth paper, this costs every mark
    // already given, because a perfect answer could never have scored full.
    const problems = validateRubric(THREE_MARK, 6);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe("total");
    expect(problems[0]!.message).toMatch(/could not get full marks/i);
  });

  it("refuses one that adds up to more", () => {
    const problems = validateRubric(THREE_MARK, 2);
    expect(problems[0]!.field).toBe("total");
    expect(problems[0]!.message).toMatch(/more than the question is worth/i);
  });

  it("accepts one that adds up exactly", () => {
    expect(validateRubric(THREE_MARK, 3)).toHaveLength(0);
  });

  it("accepts half marks, which are real in CBSE marking", () => {
    const half = rubric(
      { id: "a", label: "Method", marks: 1.5 },
      { id: "b", label: "Answer", marks: 1.5 },
    );
    expect(validateRubric(half, 3)).toHaveLength(0);
  });

  it("refuses thirds, which are not", () => {
    const thirds = rubric(
      { id: "a", label: "Method", marks: 1.33 },
      { id: "b", label: "Answer", marks: 1.67 },
    );
    // A rubric that permits them produces totals that do not add up on paper.
    expect(thirds).toBeDefined();
    expect(
      validateRubric(thirds, 3).some((problem) => problem.field === "marks"),
    ).toBe(true);
  });
});

describe("no rubric is a valid state", () => {
  it("accepts null without complaint", () => {
    // A mark scheme is an improvement on typing a number, never a gate in
    // front of it — and every question authored before this existed has none.
    expect(validateRubric(null, 5)).toHaveLength(0);
  });

  it("refuses an empty one, which is different", () => {
    const problems = validateRubric({ criteria: [] }, 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe("criteria");
  });
});

describe("the criteria themselves", () => {
  it("refuses a criterion worth nothing", () => {
    const zero = rubric(
      { id: "a", label: "Method", marks: 3 },
      { id: "b", label: "Neatness", marks: 0 },
    );
    const problems = validateRubric(zero, 3);
    expect(problems.some((problem) => problem.field === "marks")).toBe(true);
  });

  it("refuses two criteria with the same name", () => {
    const duplicated = rubric(
      { id: "a", label: "Working", marks: 2 },
      { id: "b", label: "working", marks: 1 },
    );
    // Two boxes a marker cannot tell apart, and a breakdown a student cannot
    // read.
    const problems = validateRubric(duplicated, 3);
    expect(problems.some((problem) => problem.field === "label")).toBe(true);
  });

  it("refuses an unnamed criterion", () => {
    const unnamed = rubric(
      { id: "a", label: "", marks: 2 },
      { id: "b", label: "Answer", marks: 1 },
    );
    const problems = validateRubric(unnamed, 3);
    expect(problems.some((problem) => problem.field === "label")).toBe(true);
  });

  it("caps how many a marker has to hold at once", () => {
    const many = rubric(
      ...Array.from({ length: MAX_CRITERIA + 1 }, (_, index) => ({
        id: `c${index}`,
        label: `Criterion ${index}`,
        marks: 1,
      })),
    );
    const problems = validateRubric(many, MAX_CRITERIA + 1);
    expect(problems.some((problem) => problem.field === "criteria")).toBe(true);
  });
});

describe("marking against a scheme", () => {
  it("requires every criterion to be marked", () => {
    // A partly filled rubric produces a total that looks like a judgement and
    // is actually an omission.
    const problems = validateScores(THREE_MARK, [
      { criterionId: "method", marks: 2 },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/has not been marked/i);
  });

  it("refuses a mark above what the criterion is worth", () => {
    const problems = validateScores(THREE_MARK, [
      { criterionId: "method", marks: 3 },
      { criterionId: "answer", marks: 1 },
    ]);
    // Refused, never clamped — the same rule the total box follows. A marker
    // typing 3 into a 2-mark criterion has made a mistake, and storing 2 hides
    // it from them now and from the student's total forever.
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/is worth 2/);
  });

  it("refuses a negative mark", () => {
    const problems = validateScores(THREE_MARK, [
      { criterionId: "method", marks: -1 },
      { criterionId: "answer", marks: 1 },
    ]);
    expect(problems.some((problem) => /negative/i.test(problem.message))).toBe(true);
  });

  it("refuses a criterion that is not on the scheme", () => {
    const problems = validateScores(THREE_MARK, [
      { criterionId: "method", marks: 2 },
      { criterionId: "answer", marks: 1 },
      { criterionId: "invented", marks: 1 },
    ]);
    expect(problems.some((problem) => /not on this question/i.test(problem.message))).toBe(
      true,
    );
  });

  it("refuses the same criterion twice", () => {
    const problems = validateScores(THREE_MARK, [
      { criterionId: "method", marks: 2 },
      { criterionId: "method", marks: 1 },
      { criterionId: "answer", marks: 1 },
    ]);
    expect(problems.some((problem) => /twice/i.test(problem.message))).toBe(true);
  });

  it("accepts a full, valid marking", () => {
    const scores = [
      { criterionId: "method", marks: 1.5 },
      { criterionId: "answer", marks: 1 },
    ];
    expect(validateScores(THREE_MARK, scores)).toHaveLength(0);
    // The total is derived here and nowhere else, so a marker cannot disagree
    // with their own breakdown.
    expect(totalFor(scores)).toBe(2.5);
  });
});

describe("reading a stored scheme back", () => {
  it("round-trips a good one", () => {
    expect(parseRubric(JSON.parse(JSON.stringify(THREE_MARK)))).toEqual({
      criteria: [
        { id: "method", label: "Method", marks: 2, descriptor: null },
        { id: "answer", label: "Final answer", marks: 1, descriptor: null },
      ],
    });
  });

  it("treats a malformed one as absent, not as empty", () => {
    // Absent means "type a total". Empty would mean "this question is worth
    // nothing", which is a different and much worse claim.
    expect(parseRubric(null)).toBeNull();
    expect(parseRubric({})).toBeNull();
    expect(parseRubric({ criteria: [] })).toBeNull();
    expect(parseRubric({ criteria: [{ id: "a", label: "A" }] })).toBeNull();
    expect(parseRubric({ criteria: [{ id: 1, label: "A", marks: 2 }] })).toBeNull();
    expect(parseRubric("not an object")).toBeNull();
  });
});
