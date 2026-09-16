import { describe, expect, it } from "vitest";
import { markAnswer, summarise, type Markable } from "@/core/attempts/score";

const opts = (...items: [string, boolean][]) =>
  items.map(([text, isCorrect], index) => ({
    key: String.fromCharCode(65 + index),
    text,
    isCorrect,
  }));

const mcq = (over: Partial<Markable> = {}): Markable => ({
  type: "MCQ",
  maxMarks: 2,
  options: opts(["AA", true], ["SSS", false], ["SAS", false]),
  answerKey: null,
  response: { kind: "choice", keys: ["A"] },
  ...over,
});

describe("null is not zero", () => {
  it("a subjective answer scores null until a person marks it", () => {
    // Not zero. A null that becomes a 0 inside an average is how a product
    // tells a parent their child failed a question nobody has marked.
    const mark = markAnswer({
      type: "SA",
      maxMarks: 3,
      options: null,
      answerKey: null,
      response: { kind: "text", value: "A perfectly good written answer." },
    });
    expect(mark.awardedMarks).toBeNull();
    expect(mark.isCorrect).toBeNull();
    expect(mark.reason).toBe("awaiting-marking");
  });

  it("an untouched question scores null, not zero", () => {
    // "Did not reach it" and "does not know it" are different facts, and the
    // difference matters when the paper is used to say what a student knows.
    const mark = markAnswer(mcq({ response: null }));
    expect(mark.awardedMarks).toBeNull();
    expect(mark.reason).toBe("unanswered");
  });

  it("an empty selection counts as untouched", () => {
    expect(markAnswer(mcq({ response: { kind: "choice", keys: [] } })).reason).toBe(
      "unanswered",
    );
  });

  it("blank text counts as untouched", () => {
    const mark = markAnswer({
      type: "FILL_BLANK",
      maxMarks: 1,
      options: null,
      answerKey: { kind: "text", accepted: ["square"], caseSensitive: false },
      response: { kind: "text", value: "   " },
    });
    expect(mark.reason).toBe("unanswered");
  });

  it("an answer that was given and is wrong scores zero", () => {
    const mark = markAnswer(mcq({ response: { kind: "choice", keys: ["B"] } }));
    expect(mark.awardedMarks).toBe(0);
    expect(mark.isCorrect).toBe(false);
    expect(mark.reason).toBe("incorrect");
  });
});

describe("single-answer choice", () => {
  it("awards full marks for the right option", () => {
    const mark = markAnswer(mcq());
    expect(mark).toMatchObject({ isCorrect: true, awardedMarks: 2 });
  });

  it("marks two selections wrong on a one-answer question", () => {
    expect(
      markAnswer(mcq({ response: { kind: "choice", keys: ["A", "B"] } })).isCorrect,
    ).toBe(false);
  });

  it("refuses to mark when the key is missing rather than failing everyone", () => {
    // A question edited outside the product could arrive with no correct
    // option. Marking every student wrong would be worse than marking nobody.
    const mark = markAnswer(
      mcq({ options: opts(["AA", false], ["SSS", false]) }),
    );
    expect(mark.reason).toBe("no-key");
    expect(mark.awardedMarks).toBeNull();
  });
});

describe("multi-select", () => {
  const multi = (keys: string[]): Markable => ({
    type: "MULTI_SELECT",
    maxMarks: 4,
    options: opts(["A", true], ["B", true], ["C", false], ["D", false]),
    answerKey: null,
    response: { kind: "choice", keys },
  });

  it("awards full marks for exactly the right set", () => {
    expect(markAnswer(multi(["A", "B"]))).toMatchObject({
      isCorrect: true,
      awardedMarks: 4,
      reason: "correct",
    });
  });

  it("gives partial credit for one of two", () => {
    expect(markAnswer(multi(["A"]))).toMatchObject({
      awardedMarks: 2,
      reason: "partial",
      isCorrect: false,
    });
  });

  it("penalises a wrong tick", () => {
    // One right, one wrong nets zero over two correct answers.
    expect(markAnswer(multi(["A", "C"])).awardedMarks).toBe(0);
  });

  it("scores zero for ticking everything, not full marks", () => {
    // Without the penalty this is the strategy that beats the question, and
    // the question then measures nothing.
    expect(markAnswer(multi(["A", "B", "C", "D"])).awardedMarks).toBe(0);
  });

  it("never goes negative", () => {
    expect(markAnswer(multi(["C", "D"])).awardedMarks).toBe(0);
  });
});

describe("true or false", () => {
  const tf = (value: boolean, correct: boolean): Markable => ({
    type: "TRUE_FALSE",
    maxMarks: 1,
    options: null,
    answerKey: { kind: "boolean", correct },
    response: { kind: "boolean", value },
  });

  it("marks agreement correct", () => {
    expect(markAnswer(tf(true, true)).isCorrect).toBe(true);
    expect(markAnswer(tf(false, false)).isCorrect).toBe(true);
  });

  it("marks disagreement wrong", () => {
    expect(markAnswer(tf(true, false)).isCorrect).toBe(false);
  });

  it("does not treat false as unanswered", () => {
    // The bug this guards: `false` is a real answer, and a falsy check would
    // silently mark it as never attempted.
    expect(markAnswer(tf(false, false)).reason).toBe("correct");
  });
});

describe("numeric", () => {
  const numeric = (given: number, tolerance = 0.01): Markable => ({
    type: "NUMERIC",
    maxMarks: 2,
    options: null,
    answerKey: { kind: "numeric", value: 5, tolerance },
    response: { kind: "numeric", value: given },
  });

  it("accepts the exact value", () => {
    expect(markAnswer(numeric(5)).isCorrect).toBe(true);
  });

  it("accepts a value inside the tolerance", () => {
    expect(markAnswer(numeric(5.005)).isCorrect).toBe(true);
    expect(markAnswer(numeric(4.995)).isCorrect).toBe(true);
  });

  it("accepts a value exactly on the boundary", () => {
    // An author writing "± 0.5" means 0.5 is acceptable, and binary floating
    // point must not decide otherwise.
    expect(markAnswer(numeric(5.5, 0.5)).isCorrect).toBe(true);
    expect(markAnswer(numeric(4.5, 0.5)).isCorrect).toBe(true);
  });

  it("rejects a value outside it", () => {
    expect(markAnswer(numeric(5.6, 0.5)).isCorrect).toBe(false);
  });

  it("handles a value that is not a number", () => {
    expect(markAnswer(numeric(Number.NaN)).reason).toBe("unanswered");
  });

  it("marks zero correctly when zero is the answer", () => {
    const mark = markAnswer({
      type: "NUMERIC",
      maxMarks: 1,
      options: null,
      answerKey: { kind: "numeric", value: 0, tolerance: 0 },
      response: { kind: "numeric", value: 0 },
    });
    // Another falsy trap: 0 is a real answer.
    expect(mark.isCorrect).toBe(true);
    expect(mark.reason).toBe("correct");
  });
});

describe("fill in the blank", () => {
  const blank = (given: string, caseSensitive = false): Markable => ({
    type: "FILL_BLANK",
    maxMarks: 1,
    options: null,
    answerKey: { kind: "text", accepted: ["square", "the square"], caseSensitive },
    response: { kind: "text", value: given },
  });

  it("accepts any listed form", () => {
    expect(markAnswer(blank("square")).isCorrect).toBe(true);
    expect(markAnswer(blank("the square")).isCorrect).toBe(true);
  });

  it("ignores case and stray whitespace by default", () => {
    // Marking "Square " wrong teaches a student the product is arbitrary.
    expect(markAnswer(blank("  Square  ")).isCorrect).toBe(true);
    expect(markAnswer(blank("THE   SQUARE")).isCorrect).toBe(true);
  });

  it("respects case when the author asked for it", () => {
    expect(markAnswer(blank("Square", true)).isCorrect).toBe(false);
    expect(markAnswer(blank("square", true)).isCorrect).toBe(true);
  });

  it("rejects an answer that is not listed", () => {
    expect(markAnswer(blank("cube")).isCorrect).toBe(false);
  });
});

describe("summarise", () => {
  const correct = markAnswer(mcq());
  const wrong = markAnswer(mcq({ response: { kind: "choice", keys: ["B"] } }));
  const untouched = markAnswer(mcq({ response: null }));
  const written = markAnswer({
    type: "SA",
    maxMarks: 3,
    options: null,
    answerKey: null,
    response: { kind: "text", value: "An answer." },
  });

  it("adds up what has been marked", () => {
    const summary = summarise([correct, wrong]);
    expect(summary.rawScore).toBe(2);
    expect(summary.maxScore).toBe(4);
    expect(summary.percentage).toBe(50);
    expect(summary.provisional).toBe(false);
  });

  it("counts unmarked questions as pending, never as zero", () => {
    // Reporting them as zero would understate the student until somebody
    // marks them, which is a claim the product cannot defend.
    const summary = summarise([correct, written]);
    expect(summary.rawScore).toBe(2);
    expect(summary.pendingMarks).toBe(3);
    expect(summary.awaitingMarking).toBe(1);
    expect(summary.provisional).toBe(true);
  });

  it("does not count an untouched question as pending", () => {
    // Both are unscored, and only one is waiting on a person. Counting a
    // skipped question here promises a student marks that are never coming,
    // and puts marking on a teacher's list that nobody can ever do.
    const summary = summarise([correct, untouched]);
    expect(summary.rawScore).toBe(2);
    expect(summary.pendingMarks).toBe(0);
    expect(summary.unanswered).toBe(1);
    expect(summary.answered).toBe(1);
  });

  it("separates a blank question from one waiting on a marker", () => {
    const summary = summarise([untouched, written]);
    expect(summary.unanswered).toBe(1);
    expect(summary.awaitingMarking).toBe(1);
    // Only the written answer's marks are owed.
    expect(summary.pendingMarks).toBe(3);
    expect(summary.provisional).toBe(true);
  });

  it("is not provisional when everything objective is marked", () => {
    expect(summarise([correct, wrong, untouched]).provisional).toBe(false);
  });

  it("handles an empty paper without dividing by zero", () => {
    expect(summarise([])).toMatchObject({
      rawScore: 0,
      maxScore: 0,
      percentage: 0,
    });
  });

  it("rounds to two places rather than trailing float noise", () => {
    const partial = markAnswer({
      type: "MULTI_SELECT",
      maxMarks: 1,
      options: opts(["A", true], ["B", true], ["C", true]),
      answerKey: null,
      response: { kind: "choice", keys: ["A"] },
    });
    expect(partial.awardedMarks).toBe(0.33);
    expect(summarise([partial]).rawScore).toBe(0.33);
  });
});
