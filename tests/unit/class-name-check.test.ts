import { describe, expect, it } from "vitest";
import {
  claimedClassNumber,
  classNameContradictsGrade,
} from "@/core/classes/name-check";

describe("claimedClassNumber", () => {
  it("reads the class number a name claims", () => {
    expect(claimedClassNumber("Class 10-A")).toBe(10);
    expect(claimedClassNumber("Class 9-B")).toBe(9);
    expect(claimedClassNumber("10 A")).toBe(10);
    expect(claimedClassNumber("9th standard")).toBe(9);
  });

  it("reads Roman numerals, which CBSE uses as often as digits", () => {
    expect(claimedClassNumber("Class X-A")).toBe(10);
    expect(claimedClassNumber("Class IX")).toBe(9);
    expect(claimedClassNumber("class ix morning")).toBe(9);
  });

  it("finds no claim in a name that makes none", () => {
    expect(claimedClassNumber("Morning Batch")).toBeNull();
    expect(claimedClassNumber("Priya's group")).toBeNull();
    expect(claimedClassNumber("")).toBeNull();
  });

  it("does not read a stray letter inside a word as a Roman numeral", () => {
    // The bug the character-class boundary exists to prevent.
    expect(claimedClassNumber("Xavier's group")).toBeNull();
    expect(claimedClassNumber("Phoenix batch")).toBeNull();
    expect(claimedClassNumber("Matrix set")).toBeNull();
  });

  it("does not read a digit inside a longer number", () => {
    expect(claimedClassNumber("Room 109")).toBeNull();
    expect(claimedClassNumber("Batch 2910")).toBeNull();
  });
});

describe("classNameContradictsGrade", () => {
  it("flags a name filed under the wrong year", () => {
    expect(classNameContradictsGrade("Class 10-A", 9)).toBe(true);
    expect(classNameContradictsGrade("Class IX-B", 10)).toBe(true);
  });

  it("stays quiet when they agree", () => {
    expect(classNameContradictsGrade("Class 10-A", 10)).toBe(false);
    expect(classNameContradictsGrade("Class X", 10)).toBe(false);
  });

  it("stays quiet when the name claims nothing", () => {
    // A teacher who calls the group "Morning Batch" is not making a mistake.
    expect(classNameContradictsGrade("Morning Batch", 9)).toBe(false);
  });
});

describe("ordinal forms", () => {
  it("reads the ordinals teachers actually write", () => {
    expect(claimedClassNumber("9th standard")).toBe(9);
    expect(claimedClassNumber("10th A")).toBe(10);
    expect(claimedClassNumber("Class 10th")).toBe(10);
  });

  it("still refuses a digit buried in a longer token", () => {
    expect(claimedClassNumber("Room 109")).toBeNull();
    expect(claimedClassNumber("9xy group")).toBeNull();
  });
});
