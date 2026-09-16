import { describe, expect, it } from "vitest";
import {
  buildResponse,
  isBlankResponse,
  normaliseResponse,
  parseNumber,
  resumeSequence,
  toggleKey,
} from "@/core/attempts/response";
import { markAnswer } from "@/core/attempts/score";

/**
 * The one place a response is built, for the player, practice and the retry.
 *
 * Two of the three used to build their own, and a right number was marked
 * wrong as text while a multi-select could never be right. These tests run the
 * built response through the real marker, because "the helper produces the
 * shape the marker reads" is the whole claim.
 */

const draft = (over: Partial<Parameters<typeof buildResponse>[0]>) => ({
  type: "MCQ",
  hasOptions: false,
  keys: [],
  bool: null,
  text: "",
  ...over,
});

describe("numbers", () => {
  it("reads exactly what was typed, small decimals and negatives included", () => {
    expect(parseNumber("2.05")).toBe(2.05);
    expect(parseNumber("0.05")).toBe(0.05);
    expect(parseNumber("-0.5")).toBe(-0.5);
    expect(parseNumber(".5")).toBe(0.5);
    expect(parseNumber("3,5")).toBe(3.5);
  });

  it("refuses what is not a number yet, rather than guessing", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("-")).toBeNull();
    expect(parseNumber("12abc")).toBeNull();
  });

  it("sends a typed number as a number, which the marker reads as right", () => {
    const response = buildResponse(draft({ type: "NUMERIC", text: "2.05" }));
    expect(response).toEqual({ kind: "numeric", value: 2.05 });

    const marked = markAnswer({
      type: "NUMERIC",
      maxMarks: 1,
      options: null,
      answerKey: { kind: "numeric", value: 2.05, tolerance: 0 },
      response,
    });
    expect(marked.isCorrect).toBe(true);
  });
});

describe("multi-select", () => {
  const options = [
    { key: "A", text: "one", isCorrect: true },
    { key: "B", text: "two", isCorrect: false },
    { key: "C", text: "three", isCorrect: true },
  ];

  it("toggles on a multi-select and moves the choice on a single answer", () => {
    expect(toggleKey("MULTI_SELECT", ["A"], "C")).toEqual(["A", "C"]);
    expect(toggleKey("MULTI_SELECT", ["A", "C"], "A")).toEqual(["C"]);
    expect(toggleKey("MCQ", ["A"], "C")).toEqual(["C"]);
  });

  it("carries every tick, so a two-answer question can be got right", () => {
    let keys: string[] = [];
    keys = toggleKey("MULTI_SELECT", keys, "A");
    keys = toggleKey("MULTI_SELECT", keys, "C");
    const response = buildResponse(draft({ type: "MULTI_SELECT", hasOptions: true, keys }));

    const marked = markAnswer({
      type: "MULTI_SELECT",
      maxMarks: 2,
      options,
      answerKey: null,
      response,
    });
    expect(marked.isCorrect).toBe(true);
    expect(marked.awardedMarks).toBe(2);
  });
});

describe("blank is null", () => {
  it("builds nothing from an empty selection, a box of spaces or no choice", () => {
    expect(buildResponse(draft({ type: "MULTI_SELECT", hasOptions: true, keys: [] }))).toBeNull();
    expect(buildResponse(draft({ type: "SA", text: "   " }))).toBeNull();
    expect(buildResponse(draft({ type: "TRUE_FALSE" }))).toBeNull();
    expect(buildResponse(draft({ type: "NUMERIC", text: "-" }))).toBeNull();
  });

  it("normalises a stored blank to null and leaves a real answer alone", () => {
    expect(normaliseResponse({ kind: "choice", keys: [] })).toBeNull();
    expect(normaliseResponse({ kind: "text", value: " \n " })).toBeNull();
    expect(normaliseResponse({ kind: "boolean", value: false })).toEqual({
      kind: "boolean",
      value: false,
    });
    expect(isBlankResponse({ kind: "numeric", value: 0 })).toBe(false);
  });
});

describe("resuming after a reload", () => {
  it("starts above the highest sequence the server holds", () => {
    expect(resumeSequence([{ clientSeq: 0 }, { clientSeq: 0 }])).toBe(1);
    expect(resumeSequence([{ clientSeq: 7 }, { clientSeq: 3 }])).toBe(8);
    expect(resumeSequence([])).toBe(1);
  });
});
