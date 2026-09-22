import { describe, expect, it } from "vitest";
import {
  isTop,
  leaksAnswer,
  nextLevel,
  LEVEL_BLURB,
  LEVEL_LABEL,
  type AnswerKey,
  type Option,
} from "@/core/tutor/guard";

/**
 * The guard is the feature.
 *
 * These tests are written from the two directions that matter and they pull
 * against each other on purpose:
 *
 *   - a hint that hands over the answer must be caught, every time;
 *   - a hint that teaches must NOT be caught, or the fallback fires constantly
 *     and every student gets the same authored sentence.
 *
 * The second set is the one that would rot first, because a check made stricter
 * to catch one bad reply passes its own test and quietly breaks the feature.
 */

const OPTIONS: Option[] = [
  { key: "A", text: "AA", isCorrect: false },
  { key: "B", text: "SAS", isCorrect: true },
  { key: "C", text: "SSS", isCorrect: false },
  { key: "D", text: "RHS", isCorrect: false },
];

describe("leaksAnswer, on multiple choice", () => {
  it("catches the correct option's text", () => {
    const verdict = leaksAnswer("You need the SAS criterion here.", OPTIONS, null);
    expect(verdict).toEqual({ leaked: true, what: "option" });
  });

  it("catches it whatever the case", () => {
    expect(leaksAnswer("try sas", OPTIONS, null).leaked).toBe(true);
  });

  it("catches the key when it is used as a label", () => {
    for (const said of [
      "The answer is B",
      "the answer is (B)",
      "Option B is the one you want.",
      "choice: B",
      // The frame is a verb rather than a noun, and it gives it away just as
      // completely.
      "So pick B.",
      "Go with (B).",
      "It's B.",
    ]) {
      expect(leaksAnswer(said, OPTIONS, null).leaked, said).toBe(true);
    }
  });

  it("does NOT catch a lone letter in ordinary prose", () => {
    // "…triangle B…" is a label on a figure, not a verdict on an option, and a
    // check that fired here would fire on most geometry hints ever written.
    expect(leaksAnswer("Compare triangle A with triangle B.", OPTIONS, null).leaked)
      .toBe(false);
  });

  it("does NOT catch a wrong option's text", () => {
    // Naming what to rule out is teaching. Only the correct one is withheld.
    expect(leaksAnswer("This is not an SSS case.", OPTIONS, null).leaked).toBe(false);
  });

  it("catches the answer given by ruling out every other option", () => {
    // Found in the real-model walkthrough on the third rung: nothing names B,
    // and B is all that is left.
    for (const said of [
      "AA is for similarity, not congruence. SSS needs all three sides, and RHS needs a right angle — you have neither.",
      "Options A, C and D each need something the question does not give you.",
      "(A) is about shape only. (C) needs a third side. (D) needs a right angle.",
      "A. Only shape.\nC. Needs three sides.\nD. Needs a right angle.",
    ]) {
      expect(leaksAnswer(said, OPTIONS, null), said).toEqual({ leaked: true, what: "elimination" });
    }
  });

  it("does NOT catch ruling out SOME of the options", () => {
    // One or two set aside is still a student left to decide.
    expect(leaksAnswer("AA and SSS need something the question does not give you.", OPTIONS, null).leaked)
      .toBe(false);
    expect(leaksAnswer("Options A and C both need more than you are given.", OPTIONS, null).leaked)
      .toBe(false);
  });

  it("does NOT read a figure's labels as options", () => {
    expect(
      leaksAnswer("Triangle A, triangle C and point D are all on the figure. Compare them.", OPTIONS, null).leaked,
    ).toBe(false);
  });

  it("does NOT catch the concept, the theorem or the formula", () => {
    const teaching = [
      "Look at which pair of sides you have been given, and what sits between them.",
      "Congruence needs three facts. Count how many the question gives you.",
      "Two triangles with the same shape are similar; the same size makes them congruent.",
    ];
    for (const said of teaching) {
      expect(leaksAnswer(said, OPTIONS, null).leaked, said).toBe(false);
    }
  });

  it("matches short option text on a word boundary, not inside a word", () => {
    // "AA" is a real answer to a similarity question AND two letters that occur
    // inside ordinary words. Substring matching would reject half the language.
    const aa: Option[] = [{ key: "A", text: "AA", isCorrect: true }];
    expect(leaksAnswer("The AA criterion applies.", aa, null).leaked).toBe(true);
    expect(leaksAnswer("This is the Aakash method.", aa, null).leaked).toBe(false);
  });
});

describe("leaksAnswer, on the other answer kinds", () => {
  it("catches a stated true/false verdict but not ordinary English", () => {
    const key: AnswerKey = { kind: "boolean", correct: true };
    expect(leaksAnswer("The statement is true.", null, key).leaked).toBe(true);
    // "It is true that…" is how people write. Catching it would leave the
    // tutor unable to say anything about a true/false question at all.
    expect(
      leaksAnswer("It is true that both angles matter here.", null, key).leaked,
    ).toBe(false);
  });

  it("catches the numeric value standing alone", () => {
    const key: AnswerKey = { kind: "numeric", value: 9 };
    expect(leaksAnswer("So it comes to 9.", null, key).leaked).toBe(true);
    // The method may be described freely.
    expect(leaksAnswer("Square the ratio of the sides.", null, key).leaked).toBe(
      false,
    );
    // And a different number is a different number.
    expect(leaksAnswer("Start from the 90 degree angle.", null, key).leaked).toBe(
      false,
    );
  });

  it("catches an accepted phrase but ignores a one-or-two-letter one", () => {
    const key: AnswerKey = { kind: "text", accepted: ["photosynthesis", "pH"] };
    expect(leaksAnswer("This is photosynthesis.", null, key).leaked).toBe(true);
    // Too short to be a giveaway on its own, and it appears inside words.
    expect(leaksAnswer("Think about what the ph of it tells you.", null, key).leaked)
      .toBe(false);
  });

  it("says nothing leaked when there is no key to leak", () => {
    // A subjective question a person marks. There is no answer to give away,
    // so the tutor is unconstrained by this check — and the prompt still holds.
    expect(leaksAnswer("Anything at all.", null, null).leaked).toBe(false);
  });
});

describe("the ladder", () => {
  it("starts at HINT and climbs one rung at a time", () => {
    expect(nextLevel(null)).toBe("HINT");
    expect(nextLevel("HINT")).toBe("STEPS");
    expect(nextLevel("STEPS")).toBe("EXPLAIN");
  });

  it("stops at the top rather than wrapping", () => {
    // Wrapping to HINT would let a student cycle for a fourth phrasing at a
    // fourth cost, and would make maxLevel meaningless.
    expect(nextLevel("EXPLAIN")).toBe("EXPLAIN");
    expect(isTop("EXPLAIN")).toBe(true);
    expect(isTop("HINT")).toBe(false);
  });

  it("names every rung for what the student is agreeing to see", () => {
    for (const level of ["HINT", "STEPS", "EXPLAIN"] as const) {
      expect(LEVEL_LABEL[level].length).toBeGreaterThan(0);
      expect(LEVEL_BLURB[level].length).toBeGreaterThan(0);
      // Never a bare "Help" — the point of three buttons is that they say
      // three different things.
      expect(LEVEL_LABEL[level].toLowerCase()).not.toBe("help");
    }
  });
});
