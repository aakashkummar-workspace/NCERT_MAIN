import { describe, expect, it } from "vitest";
import { CBSE_PATTERNS, sectionNeeds } from "@/core/assessments/pattern";

/**
 * What a board paper still needs, and in what order a reviewer should read.
 *
 * The panel exists because the imported bank is approved multiple choice and
 * DRAFT everything else, so a board-pattern paper fills Section A and stops.
 */

const MATHS = CBSE_PATTERNS.MATH.sections;

/** The bank as it actually is after the import: Section A approved, the rest drafts. */
const APPROVED = [{ type: "MCQ" as const, marks: 1, count: 400 }];
const DRAFTS = [
  { type: "VSA" as const, marks: 2, count: 30 },
  { type: "SA" as const, marks: 3, count: 12 },
  { type: "CASE_STUDY" as const, marks: 4, count: 4 },
];

describe("what a board paper still needs", () => {
  it("counts a section against ONE paper, alternatives included", () => {
    const rows = sectionNeeds(MATHS, APPROVED, DRAFTS);
    const a = rows.find((row) => row.names === "A")!;
    // Twenty printed, no internal choice, and the bank has plenty.
    expect(a.wanted).toBe(20);
    expect(a.approved).toBe(400);
    const c = rows.find((row) => row.names === "C")!;
    // Six answered plus two alternatives.
    expect(c.wanted).toBe(8);
    expect(c.approved).toBe(0);
    expect(c.drafts).toBe(12);
  });

  it("puts the sections a review would unlock first, biggest gap first", () => {
    const rows = sectionNeeds(MATHS, APPROVED, DRAFTS);
    // B, C and E have drafts waiting; D has none; A is already covered.
    expect(rows.map((row) => row.names)).toEqual(["C", "B", "E", "D", "A"]);
    expect(rows.at(-1)!.approved).toBeGreaterThanOrEqual(rows.at(-1)!.wanted);
  });

  it("links to a type that actually has drafts waiting", () => {
    // Section A takes multiple choice AND assertion–reason; only the second
    // has anything to read, so that is where the link goes.
    const rows = sectionNeeds(MATHS, [], [{ type: "ASSERTION_REASON", marks: 1, count: 6 }]);
    expect(rows.find((row) => row.names === "A")!.type).toBe("ASSERTION_REASON");
  });

  it("merges a section whose questions an earlier one always claims", () => {
    // Social Science files its map question as a 5-mark long answer, which is
    // Section D's own type and marks — so D takes every one of them and F,
    // counted alone, would read "none approved" however much was reviewed.
    const rows = sectionNeeds(CBSE_PATTERNS.SST.sections, [], []);
    expect(rows.some((row) => row.names === "F")).toBe(false);
    const merged = rows.find((row) => row.names === "D and F")!;
    // Four answered, four alternatives, and the one map question.
    expect(merged.wanted).toBe(9);
  });

  it("says a bank is ready when every section is covered", () => {
    const full = MATHS.map((section) => ({
      type: section.types[0]!,
      marks: section.marksEach,
      count: section.count + section.internalChoices,
    }));
    const rows = sectionNeeds(MATHS, full, []);
    expect(rows.every((row) => row.approved >= row.wanted)).toBe(true);
  });
});
