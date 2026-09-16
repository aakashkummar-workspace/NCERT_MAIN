import { describe, expect, it } from "vitest";
import {
  hasOptions,
  isObjective,
  validateQuestion,
  type Option,
  type QuestionDraft,
} from "@/core/questions/validate";

const opts = (...items: [string, boolean][]): Option[] =>
  items.map(([text, isCorrect], index) => ({
    key: String.fromCharCode(65 + index),
    text,
    isCorrect,
  }));

const mcq = (overrides: Partial<QuestionDraft> = {}): QuestionDraft => ({
  type: "MCQ",
  stem: "Which similarity criterion uses two pairs of equal angles?",
  options: opts(["AA", true], ["SSS", false], ["SAS", false], ["RHS", false]),
  explanation: "Two equal angles force the third, so the triangles are similar.",
  marks: 1,
  outcomeIds: ["outcome-1"],
  ...overrides,
});

const errorsOf = (draft: QuestionDraft) =>
  validateQuestion(draft).problems.filter((p) => p.severity === "error");
const warningsOf = (draft: QuestionDraft) =>
  validateQuestion(draft).problems.filter((p) => p.severity === "warning");

describe("a well-formed question", () => {
  it("passes cleanly and may be approved", () => {
    const result = validateQuestion(mcq());
    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.approvable).toBe(true);
  });
});

describe("errors — things that would be wrong in a real exam", () => {
  it("catches two correct options on a single-answer question", () => {
    // The failure that costs a student a mark they earned.
    const result = validateQuestion(
      mcq({ options: opts(["AA", true], ["SSS", true], ["SAS", false]) }),
    );
    expect(result.valid).toBe(false);
    expect(result.problems[0]?.message).toMatch(/2 options are marked correct/);
  });

  it("catches no correct option at all", () => {
    const result = validateQuestion(
      mcq({ options: opts(["AA", false], ["SSS", false]) }),
    );
    expect(result.valid).toBe(false);
    expect(errorsOf(mcq({ options: opts(["AA", false], ["SSS", false]) }))[0]?.message).toMatch(
      /No option is marked correct/,
    );
  });

  it("catches two options that say the same thing", () => {
    // More than one answer would be correct, whatever the key says.
    const result = validateQuestion(
      mcq({ options: opts(["AA", true], ["aa ", false], ["SAS", false]) }),
    );
    expect(result.valid).toBe(false);
    expect(errorsOf(mcq({ options: opts(["AA", true], ["aa ", false], ["SAS", false]) }))[0]
      ?.message).toMatch(/same thing/);
  });

  it("catches a blank option", () => {
    const result = validateQuestion(
      mcq({ options: opts(["AA", true], ["", false], ["SAS", false]) }),
    );
    expect(result.valid).toBe(false);
  });

  it("catches fewer than two options", () => {
    expect(validateQuestion(mcq({ options: opts(["AA", true]) })).valid).toBe(false);
  });

  it("catches an empty or absurd stem", () => {
    expect(validateQuestion(mcq({ stem: "" })).valid).toBe(false);
    expect(validateQuestion(mcq({ stem: "Why?" })).valid).toBe(false);
    expect(validateQuestion(mcq({ stem: "x".repeat(5000) })).valid).toBe(false);
  });

  it("catches impossible marks", () => {
    expect(validateQuestion(mcq({ marks: 0 })).valid).toBe(false);
    expect(validateQuestion(mcq({ marks: -1 })).valid).toBe(false);
    expect(validateQuestion(mcq({ marks: 1.5 })).valid).toBe(false);
    expect(validateQuestion(mcq({ marks: 50 })).valid).toBe(false);
  });

  it("catches duplicate option letters", () => {
    const result = validateQuestion(
      mcq({
        options: [
          { key: "A", text: "AA", isCorrect: true },
          { key: "A", text: "SSS", isCorrect: false },
        ],
      }),
    );
    expect(result.valid).toBe(false);
  });
});

describe("multi-select", () => {
  it("accepts more than one correct option", () => {
    const result = validateQuestion(
      mcq({
        type: "MULTI_SELECT",
        options: opts(["AA", true], ["SSS", true], ["Congruence", false]),
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects every option being correct", () => {
    const result = validateQuestion(
      mcq({ type: "MULTI_SELECT", options: opts(["AA", true], ["SSS", true]) }),
    );
    expect(result.valid).toBe(false);
    expect(errorsOf(
      mcq({ type: "MULTI_SELECT", options: opts(["AA", true], ["SSS", true]) }),
    )[0]?.message).toMatch(/asks nothing/);
  });

  it("warns when only one option is correct", () => {
    const warnings = warningsOf(
      mcq({
        type: "MULTI_SELECT",
        options: opts(["AA", true], ["SSS", false], ["SAS", false]),
      }),
    );
    expect(warnings.some((w) => /single-answer/.test(w.message))).toBe(true);
  });
});

describe("numeric answers", () => {
  const numeric = (key: unknown): QuestionDraft => ({
    type: "NUMERIC",
    stem: "A triangle has sides 3 cm and 4 cm at a right angle. Find the hypotenuse in cm.",
    marks: 2,
    outcomeIds: ["outcome-1"],
    explanation: "By Pythagoras.",
    answerKey: key as QuestionDraft["answerKey"],
  });

  it("accepts a value with a sensible tolerance", () => {
    expect(
      validateQuestion(numeric({ kind: "numeric", value: 5, tolerance: 0.01 })).valid,
    ).toBe(true);
  });

  it("requires an answer", () => {
    expect(validateQuestion(numeric(null)).valid).toBe(false);
  });

  it("treats a blank answer as missing, never as zero", () => {
    // Number("") is 0, which is how a blank box used to pass as "the answer is 0".
    for (const value of [Number.NaN, null, undefined, ""]) {
      const result = validateQuestion(numeric({ kind: "numeric", value, tolerance: 0.01 }));
      expect(result.valid, String(value)).toBe(false);
      expect(
        result.problems.some((p) => p.severity === "error" && /Give the numeric answer/.test(p.message)),
      ).toBe(true);
    }
  });

  it("still accepts zero when zero is the answer", () => {
    expect(
      validateQuestion(numeric({ kind: "numeric", value: 0, tolerance: 0.01 })).valid,
    ).toBe(true);
  });

  it("warns on zero tolerance, because rounding is not a wrong answer", () => {
    const warnings = warningsOf(numeric({ kind: "numeric", value: 5, tolerance: 0 }));
    expect(warnings.some((w) => /rounds differently/.test(w.message))).toBe(true);
  });

  it("warns when the tolerance would accept almost anything", () => {
    const warnings = warningsOf(numeric({ kind: "numeric", value: 5, tolerance: 4 }));
    expect(warnings.some((w) => /almost anything/.test(w.message))).toBe(true);
  });
});

describe("fill in the blank", () => {
  const blank = (overrides: Partial<QuestionDraft> = {}): QuestionDraft => ({
    type: "FILL_BLANK",
    stem: "The ratio of the areas of two similar triangles equals the ___ of the ratio of their sides.",
    marks: 1,
    outcomeIds: ["outcome-1"],
    explanation: "Areas scale with the square of the linear ratio.",
    answerKey: { kind: "text", accepted: ["square"], caseSensitive: false },
    ...overrides,
  });

  it("accepts an answer list", () => {
    expect(validateQuestion(blank()).valid).toBe(true);
  });

  it("requires at least one accepted answer", () => {
    expect(
      validateQuestion(
        blank({ answerKey: { kind: "text", accepted: [], caseSensitive: false } }),
      ).valid,
    ).toBe(false);
  });

  it("warns when the question shows no blank", () => {
    const warnings = warningsOf(
      blank({ stem: "The ratio of areas equals the square of the side ratio." }),
    );
    expect(warnings.some((w) => /underscores/.test(w.message))).toBe(true);
  });

  it("warns about a long single accepted answer", () => {
    const warnings = warningsOf(
      blank({
        answerKey: {
          kind: "text",
          accepted: ["the square of the ratio of their corresponding sides"],
          caseSensitive: false,
        },
      }),
    );
    expect(warnings.some((w) => /wording a student got right/.test(w.message))).toBe(true);
  });
});

describe("subjective types", () => {
  const written: QuestionDraft = {
    type: "SA",
    stem: "Prove that the ratio of areas of two similar triangles is the square of the ratio of their corresponding sides.",
    marks: 3,
    outcomeIds: ["outcome-1"],
    explanation: "Expect the construction, the area formula, and the substitution.",
  };

  it("needs no options or key", () => {
    expect(validateQuestion(written).valid).toBe(true);
  });

  it("warns if an answer key is supplied", () => {
    // A subjective answer scores null until a person marks it. A key here
    // would invite an automatic zero.
    const warnings = warningsOf({
      ...written,
      answerKey: { kind: "text", accepted: ["yes"], caseSensitive: false },
    });
    expect(warnings.some((w) => /marked by a person/.test(w.message))).toBe(true);
  });

  it("warns when the expected points are not written down", () => {
    const warnings = warningsOf({ ...written, explanation: null });
    expect(warnings.some((w) => /faster to mark/.test(w.message))).toBe(true);
  });
});

describe("quality warnings that never block", () => {
  it("flags an all-of-the-above option", () => {
    const warnings = warningsOf(
      mcq({ options: opts(["AA", true], ["SSS", false], ["All of the above", false]) }),
    );
    expect(warnings.some((w) => /reading strategy/.test(w.message))).toBe(true);
    expect(
      validateQuestion(
        mcq({ options: opts(["AA", true], ["SSS", false], ["All of the above", false]) }),
      ).valid,
    ).toBe(true);
  });

  it("flags a correct option far longer than the rest", () => {
    const warnings = warningsOf(
      mcq({
        options: opts(
          [
            "Because two pairs of equal angles force the third pair to be equal as well",
            true,
          ],
          ["SSS", false],
          ["SAS", false],
        ),
      }),
    );
    expect(warnings.some((w) => /much longer/.test(w.message))).toBe(true);
  });

  it("flags a missing explanation on an objective question", () => {
    const warnings = warningsOf(mcq({ explanation: null }));
    expect(warnings.some((w) => /only that they were wrong/.test(w.message))).toBe(true);
  });

  it("flags a stem shorter than its options", () => {
    const warnings = warningsOf(
      mcq({
        stem: "Which is true here?",
        options: opts(
          ["The triangles are similar because two angles match exactly", true],
          ["They are congruent by the side-side-side rule instead", false],
        ),
      }),
    );
    expect(warnings.some((w) => /shorter than its longest option/.test(w.message))).toBe(true);
  });
});

describe("approvability", () => {
  it("a question with no outcome is valid but not approvable", () => {
    // It can be scored, but it can never inform mastery — which makes it
    // worthless to the part of the product that matters.
    const result = validateQuestion(mcq({ outcomeIds: [] }));
    expect(result.valid).toBe(true);
    expect(result.approvable).toBe(false);
    expect(result.problems[0]?.severity).toBe("warning");
  });

  it("a question with an error is neither valid nor approvable", () => {
    const result = validateQuestion(
      mcq({ options: opts(["AA", true], ["SSS", true]) }),
    );
    expect(result.valid).toBe(false);
    expect(result.approvable).toBe(false);
  });
});

describe("type helpers", () => {
  it("knows which types a machine can mark", () => {
    expect(isObjective("MCQ")).toBe(true);
    expect(isObjective("NUMERIC")).toBe(true);
    expect(isObjective("LA")).toBe(false);
    expect(isObjective("CASE_STUDY")).toBe(false);
  });

  it("knows which types carry choices", () => {
    expect(hasOptions("MCQ")).toBe(true);
    expect(hasOptions("MULTI_SELECT")).toBe(true);
    expect(hasOptions("NUMERIC")).toBe(false);
    expect(hasOptions("SA")).toBe(false);
  });
});
