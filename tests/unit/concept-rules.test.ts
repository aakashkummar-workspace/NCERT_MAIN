import { describe, expect, it } from "vitest";
import {
  chainDepth,
  checkConceptName,
  checkWeight,
  conceptSlug,
  uniqueConceptSlug,
  wouldCycle,
  MAX_NAME,
  type PrerequisiteEdge,
} from "@/core/curriculum/concept-rules";

const edge = (conceptId: string, prerequisiteId: string): PrerequisiteEdge => ({
  conceptId,
  prerequisiteId,
});

describe("slugs are derived, not typed", () => {
  it("builds a stable identifier from a name", () => {
    expect(conceptSlug("Similarity of triangles")).toBe("similarity-of-triangles");
    expect(conceptSlug("  Ratio & Proportion  ")).toBe("ratio-proportion");
  });

  it("keeps the base letter of an accented character", () => {
    // Dropping it entirely would turn two different names into the same slug.
    expect(conceptSlug("Bhinnātmak sankhya")).toBe("bhinnatmak-sankhya");
  });

  it("survives a name with no usable characters", () => {
    expect(uniqueConceptSlug("???", [])).toBe("concept");
  });

  it("resolves a collision by suffix rather than refusing", () => {
    // Two subjects legitimately teach "Ratio". Telling an author to invent a
    // different NAME because of an identifier they never see would be the tail
    // wagging the dog.
    const taken = ["ratio", "ratio-2"];
    expect(uniqueConceptSlug("Ratio", taken)).toBe("ratio-3");
  });
});

describe("names", () => {
  it("refuses one too short to be a concept", () => {
    expect(checkConceptName("x").some((p) => p.severity === "error")).toBe(true);
  });

  it("refuses one too long to sit on a heatmap column", () => {
    const long = "a".repeat(MAX_NAME + 1);
    expect(checkConceptName(long).some((p) => p.severity === "error")).toBe(true);
  });

  it("refuses a name with nothing to build an identifier from", () => {
    expect(checkConceptName("!!!!").some((p) => p.severity === "error")).toBe(true);
  });

  it("warns, never blocks, when it reads like a chapter", () => {
    const problems = checkConceptName("Chapter 6 Triangles");
    // A concept is what a student can or cannot DO. But a rule that fires on
    // good input gets ignored on bad input, so this one advises.
    expect(problems.some((p) => p.severity === "warning")).toBe(true);
    expect(problems.some((p) => p.severity === "error")).toBe(false);
  });

  it("passes a real concept name cleanly", () => {
    expect(checkConceptName("Similarity of triangles")).toHaveLength(0);
  });
});

describe("weights", () => {
  it("accepts a full and a partial mapping", () => {
    expect(checkWeight(1)).toHaveLength(0);
    expect(checkWeight(0.4)).toHaveLength(0);
  });

  it("refuses zero", () => {
    // A link worth nothing makes the coverage figure claim an outcome is
    // covered when nothing will ever be measured through it.
    expect(checkWeight(0)).toHaveLength(1);
  });

  it("refuses more than one, and nonsense", () => {
    expect(checkWeight(1.5)).toHaveLength(1);
    expect(checkWeight(Number.NaN)).toHaveLength(1);
    expect(checkWeight(-1)).toHaveLength(1);
  });
});

describe("prerequisite cycles", () => {
  it("refuses a concept requiring itself", () => {
    expect(wouldCycle([], "a", "a")).toBe(true);
  });

  it("refuses a direct loop", () => {
    // a requires b; adding "b requires a" closes it.
    expect(wouldCycle([edge("a", "b")], "b", "a")).toBe(true);
  });

  it("refuses a loop three deep", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    // Adding "c requires a" makes every concept the cause of itself, and
    // root-cause analysis then either loops or sends a teacher round in
    // circles — the second being worse, because it looks like an answer.
    expect(wouldCycle(edges, "c", "a")).toBe(true);
  });

  it("allows a diamond, which is not a cycle", () => {
    // a requires b and c; both require d. Perfectly ordinary.
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d")];
    expect(wouldCycle(edges, "c", "d")).toBe(false);
  });

  it("allows an unrelated edge", () => {
    expect(wouldCycle([edge("a", "b")], "c", "d")).toBe(false);
  });

  it("allows deepening an existing chain", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(wouldCycle(edges, "c", "d")).toBe(false);
  });

  it("terminates on a graph that already contains a cycle", () => {
    // Should not be reachable through the writes, but a pure function that
    // hangs on bad input is a pure function that takes the server with it.
    const edges = [edge("a", "b"), edge("b", "a")];
    expect(wouldCycle(edges, "c", "a")).toBe(false);
    expect(wouldCycle(edges, "a", "b")).toBe(true);
  });
});

describe("chain depth", () => {
  it("counts the longest run of prerequisites", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
    expect(chainDepth(edges, "a")).toBe(3);
    expect(chainDepth(edges, "c")).toBe(1);
    expect(chainDepth(edges, "d")).toBe(0);
  });

  it("takes the longest branch, not the first", () => {
    const edges = [edge("a", "b"), edge("a", "x"), edge("b", "c")];
    expect(chainDepth(edges, "a")).toBe(2);
  });

  it("does not hang on a cycle", () => {
    const edges = [edge("a", "b"), edge("b", "a")];
    expect(chainDepth(edges, "a")).toBeLessThan(10);
  });
});
