import { describe, expect, it } from "vitest";
import {
  recommend,
  recommendFor,
  MIN_SET,
  MAX_SET,
  type ConceptState,
} from "@/core/practice/recommend";

const base: ConceptState = {
  conceptId: "c1",
  conceptName: "Similar triangles",
  estimate: 0.5,
  band: "FRAGILE",
  openMistakes: 0,
  lastEvidenceAt: new Date("2026-09-01T00:00:00Z"),
  available: 12,
};

const now = new Date("2026-09-09T00:00:00Z");
const state = (patch: Partial<ConceptState>): ConceptState => ({ ...base, ...patch });

describe("it refuses rather than guess", () => {
  it("says nothing at all when nothing is measured", () => {
    // The fifth application of the refusal pattern. A confident suggestion
    // built on no evidence spends a student's evening on a guess.
    const result = recommendFor(
      [state({ estimate: null, band: "INSUFFICIENT" })],
      now,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("nothing-measured");
      expect(result.message).toMatch(/sit a test/i);
    }
  });

  it("distinguishes a thin bank from a student who is doing fine", () => {
    // Two different instructions. "Your teacher can add some" and "you are on
    // top of everything" must never be the same sentence.
    const thin = recommendFor([state({ available: 1 })], now);
    expect(thin.ok).toBe(false);
    if (!thin.ok) {
      expect(thin.reason).toBe("bank-too-thin");
      expect(thin.message).toMatch(/teacher/i);
    }

    const fine = recommendFor(
      [state({ estimate: 0.72, band: "DEVELOPING", available: 12 })],
      now,
    );
    expect(fine.ok).toBe(false);
    if (!fine.ok) expect(fine.reason).toBe("nothing-to-practise");
  });

  it("never recommends a concept it cannot fill a set from", () => {
    // A recommendation that opens an empty set has already spent the tap.
    for (const available of [0, 1, 2, 3]) {
      expect(recommend([state({ estimate: 0.2, available })], now)).toHaveLength(0);
    }
    expect(recommend([state({ estimate: 0.2, available: 4 })], now)).toHaveLength(1);
  });
});

describe("what comes first", () => {
  it("puts questions they already got wrong above everything", () => {
    const candidates = recommend(
      [
        state({ conceptId: "weak", conceptName: "Weak", estimate: 0.2 }),
        state({
          conceptId: "mistakes",
          conceptName: "Mistakes",
          estimate: 0.75,
          openMistakes: 2,
        }),
      ],
      now,
    );
    // The most specific thing the product knows about this student.
    expect(candidates[0]!.conceptId).toBe("mistakes");
    expect(candidates[0]!.reason).toBe("mistakes");
  });

  it("orders the rest weakest first", () => {
    const candidates = recommend(
      [
        state({ conceptId: "a", conceptName: "A", estimate: 0.55 }),
        state({ conceptId: "b", conceptName: "B", estimate: 0.25 }),
        state({ conceptId: "c", conceptName: "C", estimate: 0.45 }),
      ],
      now,
    );
    expect(candidates.map((c) => c.conceptId)).toEqual(["b", "c", "a"]);
  });

  it("offers a secure concept last and never as something they need", () => {
    const candidates = recommend(
      [
        state({ conceptId: "secure", conceptName: "Secure", estimate: 0.9 }),
        state({ conceptId: "weak", conceptName: "Weak", estimate: 0.3 }),
      ],
      now,
    );
    expect(candidates[candidates.length - 1]!.reason).toBe("keep-sharp");
    expect(candidates[candidates.length - 1]!.rationale).toMatch(/solid|if you want/i);
  });

  it("names a concept once, under its strongest reason", () => {
    // A student weak at something they also have mistakes on does not need two
    // cards telling them the same thing.
    const candidates = recommend(
      [state({ estimate: 0.2, openMistakes: 3 })],
      now,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.reason).toBe("mistakes");
  });

  it("surfaces a concept the estimator is forgetting", () => {
    // The decay is deliberate, so an untouched concept is one the product is
    // steadily less sure about — a real reason to practise, not a bug.
    const candidates = recommend(
      [
        state({
          estimate: 0.7,
          band: "DEVELOPING",
          lastEvidenceAt: new Date("2026-06-01T00:00:00Z"),
        }),
      ],
      now,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.reason).toBe("going-stale");
    expect(candidates[0]!.rationale).toMatch(/weeks/);
  });

  it("leaves a recently-practised middling concept alone", () => {
    expect(
      recommend([state({ estimate: 0.7, band: "DEVELOPING" })], now),
    ).toHaveLength(0);
  });
});

describe("what a student reads", () => {
  it("gives every candidate a sentence with the number in it", () => {
    const candidates = recommend(
      [
        state({ conceptId: "a", conceptName: "Ratios", estimate: 0.3 }),
        state({ conceptId: "b", conceptName: "Areas", estimate: 0.55 }),
        state({ conceptId: "c", conceptName: "Angles", openMistakes: 2 }),
      ],
      now,
    );
    for (const candidate of candidates) {
      // Named, so a student is never sent to another page to find out what.
      expect(candidate.rationale).toContain(candidate.conceptName);
      expect(candidate.rationale.length).toBeGreaterThan(20);
    }
    // "You are weak at this" is an accusation; "about 30%" is a fact.
    expect(candidates.find((c) => c.conceptId === "a")!.rationale).toMatch(/30%/);
  });

  it("counts one mistake in the singular", () => {
    const [one] = recommend([state({ openMistakes: 1 })], now);
    expect(one!.rationale).toMatch(/one question/i);
    expect(one!.rationale).not.toMatch(/1 questions/);
  });
});

describe("set length", () => {
  it("is longer where the repetitions are worth something", () => {
    const [weak] = recommend([state({ estimate: 0.25 })], now);
    const [fine] = recommend([state({ estimate: 0.9 })], now);
    // Ten questions on something you can already do teaches a student that
    // practice is a waste of their evening.
    expect(weak!.questionCount).toBeGreaterThan(fine!.questionCount);
  });

  it("never asks for more than the bank holds", () => {
    const [only] = recommend([state({ estimate: 0.2, available: 5 })], now);
    expect(only!.questionCount).toBeLessThanOrEqual(5);
  });

  it("stays between the floor and the ceiling", () => {
    for (const estimate of [0.05, 0.3, 0.5, 0.65, 0.95]) {
      for (const available of [4, 6, 20, 200]) {
        const [candidate] = recommend([state({ estimate, available })], now);
        if (!candidate) continue;
        expect(candidate.questionCount).toBeGreaterThanOrEqual(MIN_SET);
        expect(candidate.questionCount).toBeLessThanOrEqual(MAX_SET);
        expect(candidate.questionCount).toBeLessThanOrEqual(available);
      }
    }
  });
});
