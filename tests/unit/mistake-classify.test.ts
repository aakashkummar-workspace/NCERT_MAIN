import { describe, expect, it } from "vitest";
import { adviceFor, classify, labelFor, type AnswerFacts } from "@/core/mistakes/classify";

const base: AnswerFacts = {
  responded: true,
  timeSpentSeconds: 60,
  expectedTimeSeconds: 90,
  secondsBeforeSubmit: 600,
  ranOutOfTime: false,
  visitCount: 2,
  conceptEstimate: 0.5,
  hasWriting: false,
  type: "MCQ",
};

const facts = (patch: Partial<AnswerFacts>): AnswerFacts => ({ ...base, ...patch });

describe("the rules that cost nothing", () => {
  it("types a blank as unattempted", () => {
    const verdict = classify(facts({ responded: false }));
    expect(verdict.type).toBe("UNATTEMPTED");
    expect(verdict.source).toBe("RULE");
  });

  it("distinguishes a blank from one the clock beat them to", () => {
    // Different facts about the student, and they lead to different evenings:
    // one is about the concept, the other about how they used the hour.
    const skipped = classify(facts({ responded: false }));
    const timedOut = classify(facts({ responded: false, ranOutOfTime: true }));
    expect(skipped.type).toBe("UNATTEMPTED");
    expect(timedOut.type).toBe("TIME_PRESSURE");
  });

  it("types an answer written in the last minute of a timed-out paper", () => {
    const verdict = classify(
      facts({ ranOutOfTime: true, secondsBeforeSubmit: 20 }),
    );
    expect(verdict.type).toBe("TIME_PRESSURE");
    expect(verdict.source).toBe("RULE");
  });

  it("does not blame the clock for an answer written with time to spare", () => {
    const verdict = classify(
      facts({ ranOutOfTime: true, secondsBeforeSubmit: 1800 }),
    );
    expect(verdict.type).not.toBe("TIME_PRESSURE");
  });
});

describe("careless needs corroboration, not just speed", () => {
  it("types a rushed answer on a concept they can do", () => {
    const verdict = classify(
      facts({ timeSpentSeconds: 8, expectedTimeSeconds: 90, conceptEstimate: 0.82, visitCount: 1 }),
    );
    expect(verdict.type).toBe("CARELESS");
    expect(verdict.source).toBe("RULE");
  });

  it("refuses to call it careless when they cannot do the concept", () => {
    // The error that actively misleads. A student who does not know something
    // also answers quickly, and telling them they were merely sloppy sends
    // them back to a question they have no way of getting right.
    const verdict = classify(
      facts({ timeSpentSeconds: 8, expectedTimeSeconds: 90, conceptEstimate: 0.3, visitCount: 1 }),
    );
    expect(verdict.type).not.toBe("CARELESS");
    expect(verdict.source).toBe("PENDING");
  });

  it("refuses when there is no mastery to corroborate with", () => {
    const verdict = classify(
      facts({ timeSpentSeconds: 8, expectedTimeSeconds: 90, conceptEstimate: null, visitCount: 1 }),
    );
    expect(verdict.type).not.toBe("CARELESS");
  });

  it("refuses when the author gave no expected time", () => {
    // Without an estimate there is no such thing as "too fast". A hard-coded
    // threshold would call every one-mark true/false answer careless.
    const verdict = classify(
      facts({ timeSpentSeconds: 4, expectedTimeSeconds: null, conceptEstimate: 0.9, visitCount: 1 }),
    );
    expect(verdict.type).not.toBe("CARELESS");
  });

  it("refuses when they came back to it", () => {
    // Three visits is not carelessness. They thought about it.
    const verdict = classify(
      facts({ timeSpentSeconds: 8, expectedTimeSeconds: 90, conceptEstimate: 0.9, visitCount: 3 }),
    );
    expect(verdict.type).not.toBe("CARELESS");
  });
});

describe("what is not worth asking a model about", () => {
  it("settles a wrong true/false for free, as undecided", () => {
    // Two options and they picked the other one. That is one bit, and one bit
    // cannot separate "does not understand" from "misread" from "guessed" — so
    // a model asked about it can only invent an explanation, which is the one
    // failure this file is arranged to avoid.
    const verdict = classify(facts({ type: "TRUE_FALSE" }));
    expect(verdict.source).toBe("RULE");
    expect(verdict.type).toBe("UNCLASSIFIED");
    // Settled means settled: it must not rejoin the nightly queue to be
    // answered UNSURE at a cost, every night, forever.
    expect(verdict.reason).toBeTruthy();
  });

  it("still asks about a wrong multiple choice", () => {
    // Which distractor they picked often names the misconception, so this one
    // is worth a token in a way the true/false is not.
    expect(classify(facts({ type: "MCQ" })).source).toBe("PENDING");
  });

  it("asks about a true/false that came with working", () => {
    const verdict = classify(facts({ type: "TRUE_FALSE", hasWriting: true }));
    expect(verdict.source).toBe("PENDING");
  });
});

describe("what reaches the model", () => {
  it("is the ambiguous remainder, and nothing else", () => {
    const verdict = classify(facts({}));
    expect(verdict.source).toBe("PENDING");
    expect(verdict.type).toBe("UNCLASSIFIED");
    // No reason invented. The card says nothing has looked at it yet.
    expect(verdict.reason).toBeNull();
  });

  it("never sends a case a rule already settled", () => {
    const settled = [
      classify(facts({ responded: false })),
      classify(facts({ responded: false, ranOutOfTime: true })),
      classify(facts({ ranOutOfTime: true, secondsBeforeSubmit: 5 })),
      classify(
        facts({ timeSpentSeconds: 5, expectedTimeSeconds: 120, conceptEstimate: 0.8, visitCount: 1 }),
      ),
      classify(facts({ type: "TRUE_FALSE" })),
    ];
    expect(settled.every((verdict) => verdict.source === "RULE")).toBe(true);
    // Every rule-typed verdict carries a sentence for the student. A type with
    // no explanation is a label, and a label teaches nobody anything.
    expect(settled.every((verdict) => (verdict.reason ?? "").length > 10)).toBe(true);
  });
});

describe("what the student is told", () => {
  it("gives every type a label and advice", () => {
    for (const type of [
      "CONCEPTUAL",
      "PROCEDURAL",
      "CARELESS",
      "UNATTEMPTED",
      "MISREAD",
      "TIME_PRESSURE",
      "UNCLASSIFIED",
    ]) {
      expect(labelFor(type).length).toBeGreaterThan(3);
      expect(adviceFor(type).length).toBeGreaterThan(10);
    }
  });

  it("falls back rather than printing an enum at a fifteen-year-old", () => {
    expect(labelFor("SOMETHING_NEW")).toBe(labelFor("UNCLASSIFIED"));
    expect(adviceFor("SOMETHING_NEW")).toBe(adviceFor("UNCLASSIFIED"));
  });

  it("gives a stuck student and a rushed one different things to do", () => {
    // The whole point of typing a mistake. The same sentence for both would
    // make the type decorative.
    expect(adviceFor("CONCEPTUAL")).not.toBe(adviceFor("CARELESS"));
    expect(adviceFor("CONCEPTUAL")).toMatch(/explanation/i);
    expect(adviceFor("CARELESS")).toMatch(/again|slowly/i);
  });

  it("never tells them to read an explanation the page is still withholding", () => {
    // The explanation is revealed only after a retry, so advice that puts
    // reading FIRST is advice the screen cannot obey — and on the CONCEPTUAL
    // line it also contradicted the only control on the page.
    for (const type of [
      "CONCEPTUAL",
      "PROCEDURAL",
      "CARELESS",
      "UNATTEMPTED",
      "MISREAD",
      "TIME_PRESSURE",
      "UNCLASSIFIED",
    ]) {
      expect(adviceFor(type)).not.toMatch(/^(go back to|read) the explanation/i);
    }
  });
});
