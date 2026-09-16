import { describe, expect, it } from "vitest";
import { checkOutcomeStatement } from "@/core/curriculum/outcome-quality";

/**
 * The check that keeps outcome statements usable as prompt material.
 *
 * With no seeded question bank to few-shot from (RISKS.md, Risk 1), an outcome
 * statement is the only grounding a generator has. A label cannot produce a
 * question; a claim about what a student can do can.
 */
describe("checkOutcomeStatement", () => {
  it("accepts a statement a question could be written from", () => {
    expect(
      checkOutcomeStatement(
        "Applies the AA, SSS and SAS similarity criteria to decide whether two given triangles are similar, and names which criterion was used.",
      ).ok,
    ).toBe(true);

    expect(
      checkOutcomeStatement(
        "Balances a chemical equation by inspection and states why mass must be conserved.",
      ).ok,
    ).toBe(true);
  });

  it("rejects a topic heading dressed as an outcome", () => {
    // The failure mode that matters: 400 of these would look like a finished
    // curriculum and generate nothing usable.
    for (const label of ["Triangles", "Similarity", "Light and reflection"]) {
      const result = checkOutcomeStatement(label);
      expect(result.ok, label).toBe(false);
    }
  });

  it("rejects a sentence with no verb the student performs", () => {
    const result = checkOutcomeStatement(
      "The chapter is about the properties of similar triangles and their many uses.",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/verb/i);
  });

  it("rejects something too long to be one claim", () => {
    const result = checkOutcomeStatement(
      "Applies the criteria for similarity, " + "and also ".repeat(60),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/two outcomes/i);
  });

  it("gives a reason an author can act on, never just a rejection", () => {
    const result = checkOutcomeStatement("Circles");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(20);
      expect(result.reason).toMatch(/[a-z]/);
    }
  });

  it("accepts every statement in the worked example", async () => {
    // The seeded chapter is what the editor is measured against. If the check
    // rejects its own exemplars, the check is wrong.
    const { WORKED_EXAMPLE } = await import("../../prisma/curriculum");
    for (const topic of WORKED_EXAMPLE.topics) {
      for (const outcome of topic.outcomes) {
        expect(
          checkOutcomeStatement(outcome.statement).ok,
          `${outcome.code}: ${outcome.statement}`,
        ).toBe(true);
      }
    }
  });
});

describe("the verb must be at the front", () => {
  it("rejects a description whose only verb-like word is a noun", () => {
    // "uses" here is a noun. Matching anywhere in the sentence let this pass.
    const result = checkOutcomeStatement(
      "The chapter is about the properties of similar triangles and their many uses.",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/start with a verb/i);
  });

  it("accepts a verb in the opening words even when it is not the first", () => {
    expect(
      checkOutcomeStatement(
        "Correctly applies the sine rule to find an unknown side in a triangle.",
      ).ok,
    ).toBe(true);
  });

  it("rejects a statement that buries the verb past the opening", () => {
    expect(
      checkOutcomeStatement(
        "In this part of the chapter the student applies the sine rule to a triangle.",
      ).ok,
    ).toBe(false);
  });
});
