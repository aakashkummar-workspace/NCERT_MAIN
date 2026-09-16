import { describe, expect, it } from "vitest";
import {
  buildReadiness,
  chaptersNeeded,
  MIN_MEASURED_CONCEPTS,
  type ReadinessChapter,
  type ReadinessConcept,
  type ReadinessInput,
} from "@/core/readiness/build";

/**
 * The readiness picture, tested without a database.
 *
 * The point of the pure module is that the rule deciding what a student
 * believes about their own preparation can be argued with here, in a file
 * somebody can read in one sitting — rather than inferred from a query.
 */

/** `n` chapters in one subject, numbered from 1. */
function chapters(n: number, subjectName = "Mathematics"): ReadinessChapter[] {
  return Array.from({ length: n }, (_, index) => ({
    chapterId: `ch-${index + 1}`,
    subjectName,
    number: index + 1,
    title: `Chapter ${index + 1}`,
  }));
}

function concept(
  id: string,
  band: ReadinessConcept["band"],
  estimate: number | null,
): ReadinessConcept {
  return {
    conceptId: id,
    conceptName: `Idea ${id}`,
    band,
    estimate,
    evidenceCount: band === "INSUFFICIENT" ? 2 : 8,
  };
}

/** One measured concept per chapter, so coverage moves chapter by chapter. */
function oneConceptPerChapter(
  count: number,
  band: ReadinessConcept["band"],
  estimate: number,
) {
  const concepts = Array.from({ length: count }, (_, index) =>
    concept(`c-${index + 1}`, band, estimate),
  );
  const chaptersByConcept = new Map(
    concepts.map((row, index) => [row.conceptId, [`ch-${index + 1}`]]),
  );
  return { concepts, chaptersByConcept };
}

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    subjectNames: ["Mathematics"],
    syllabusConceptIds: [],
    concepts: [],
    chapters: chapters(10),
    testedChapterIds: [],
    chaptersByConcept: new Map(),
    ...overrides,
  };
}

describe("it refuses, and the refusals are three different facts", () => {
  it("says there is no syllabus when the student is in no class", () => {
    const result = buildReadiness(
      input({ subjectNames: [], chapters: [], syllabusConceptIds: [] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("no-syllabus");
    // The instruction, not an apology: this one the student can fix in a minute.
    expect(result.message).toMatch(/join one with the code/i);
  });

  it("names the gap as ours when the subject has no chapters recorded", () => {
    const result = buildReadiness(
      input({ subjectNames: ["Hindi"], chapters: [], syllabusConceptIds: [] }),
    );

    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("no-syllabus");
    // Two subjects with no chapters is a real seeded state. Telling a student
    // to go and join a class would send them to fix something that is not
    // theirs to fix.
    expect(result.message).toMatch(/Hindi/);
    expect(result.message).toMatch(/gap is ours, not yours/i);
  });

  it("separates nothing-measured from too-thin", () => {
    const nothing = buildReadiness(
      input({ syllabusConceptIds: ["c-1"], concepts: [concept("c-1", "INSUFFICIENT", null)] }),
    );
    if (nothing.ok) throw new Error("expected a refusal");
    expect(nothing.reason).toBe("nothing-measured");

    const { concepts, chaptersByConcept } = oneConceptPerChapter(2, "SECURE", 0.9);
    const thin = buildReadiness(
      input({
        syllabusConceptIds: concepts.map((row) => row.conceptId),
        concepts,
        chaptersByConcept,
      }),
    );
    if (thin.ok) throw new Error("expected a refusal");
    expect(thin.reason).toBe("too-thin");

    // "We know nothing about you" and "we know about a corner of it" are
    // different sentences to a student, and sharing one would answer a
    // question they did not ask.
    expect(thin.message).not.toBe(nothing.message);
  });

  it("tells a student who HAS sat something why nothing is measured yet", () => {
    const untouched = buildReadiness(input({ syllabusConceptIds: ["c-1"] }));
    if (untouched.ok) throw new Error("expected a refusal");
    expect(untouched.message).toMatch(/once you have sat a test/i);

    const sat = buildReadiness(
      input({ syllabusConceptIds: ["c-1"], testedChapterIds: ["ch-1", "ch-2"] }),
    );
    if (sat.ok) throw new Error("expected a refusal");
    // Not "you have done nothing". They sat a paper; what is missing is
    // answers on the same idea, and saying otherwise reads as a punishment.
    expect(sat.message).toMatch(/tested on 2 chapters of the 10/i);
    expect(sat.message).toMatch(/not about you/i);
  });

  it("names both numbers in the sentence the page is built around", () => {
    const { concepts, chaptersByConcept } = oneConceptPerChapter(3, "SECURE", 0.9);
    const result = buildReadiness(
      input({
        chapters: chapters(51),
        syllabusConceptIds: concepts.map((row) => row.conceptId),
        concepts,
        chaptersByConcept,
      }),
    );

    if (result.ok) throw new Error("expected a refusal");
    // "We have measured 3 chapters" without the 51 is the flattering half of
    // the fact, and it is the half that would let somebody read this as good
    // news.
    expect(result.message).toContain("3 of the 51 chapters");
    expect(result.message).toMatch(/not enough to tell you whether you are ready/i);
    expect(result.message).toContain("48");
  });

  it("withholds the standing structurally, not by remembering to hide it", () => {
    const { concepts, chaptersByConcept } = oneConceptPerChapter(3, "SECURE", 0.95);
    const result = buildReadiness(
      input({
        syllabusConceptIds: concepts.map((row) => row.conceptId),
        concepts,
        chaptersByConcept,
      }),
    );

    if (result.ok) throw new Error("expected a refusal");
    // "3 secure" printed beside "3 of 10 chapters measured" is exactly the
    // wrong conclusion, drawn confidently. There is no field to print.
    expect("standing" in result).toBe(false);
    expect("summary" in result).toBe(false);
  });

  it("still carries the facts that need no threshold", () => {
    const result = buildReadiness(
      input({ chapters: chapters(4), testedChapterIds: ["ch-2"] }),
    );

    if (result.ok) throw new Error("expected a refusal");
    // The chapter list is the actionable half of this page and it is true
    // over any amount of evidence. A refusal that dropped it would leave a
    // student with nothing at all to do.
    expect(result.untested.map((row) => row.chapterId)).toEqual([
      "ch-1",
      "ch-3",
      "ch-4",
    ]);
    expect(result.coverage.testedChapters).toBe(1);
    expect(result.coverage.totalChapters).toBe(4);
  });
});

describe("nothing is derived from a band the estimator refused", () => {
  it("counts no INSUFFICIENT row, and measures no chapter through one", () => {
    const concepts = [
      concept("c-1", "INSUFFICIENT", null),
      concept("c-2", "INSUFFICIENT", null),
    ];
    const result = buildReadiness(
      input({
        chapters: chapters(2),
        syllabusConceptIds: ["c-1", "c-2"],
        concepts,
        chaptersByConcept: new Map([
          ["c-1", ["ch-1"]],
          ["c-2", ["ch-2"]],
        ]),
        testedChapterIds: ["ch-1", "ch-2"],
      }),
    );

    expect(result.coverage.measuredConcepts).toBe(0);
    expect(result.coverage.measuredChapters).toBe(0);
    // Tested, and still nothing to say about it. That is a third state and
    // the page has to be able to name it: "we asked, and it is not enough".
    expect(result.thin.map((row) => row.chapterId)).toEqual(["ch-1", "ch-2"]);
  });

  it("ignores an estimate that arrived on an INSUFFICIENT row anyway", () => {
    // The column is null when the band is INSUFFICIENT, so this row cannot
    // exist. It is asserted because the day it does exist — a rebuild half
    // done, a bad backfill — the answer must be to drop it, not to average it
    // into a claim about somebody's exam.
    const result = buildReadiness(
      input({
        chapters: chapters(1),
        syllabusConceptIds: ["c-1"],
        concepts: [concept("c-1", "INSUFFICIENT", 0.95)],
        chaptersByConcept: new Map([["c-1", ["ch-1"]]]),
      }),
    );

    expect(result.coverage.measuredConcepts).toBe(0);
  });

  it("keeps the denominator honest about concepts outside the syllabus", () => {
    const { concepts, chaptersByConcept } = oneConceptPerChapter(6, "SECURE", 0.9);
    const strays = [...concepts, concept("stray", "SECURE", 0.99)];

    const result = buildReadiness(
      input({
        chapters: chapters(6),
        // The stray is measured, and belongs to a subject this student is no
        // longer sitting. Counting it would move the coverage figure for a
        // reason nobody could explain.
        syllabusConceptIds: concepts.map((row) => row.conceptId),
        concepts: strays,
        chaptersByConcept,
      }),
    );

    expect(result.coverage.measuredConcepts).toBe(6);
    expect(result.coverage.totalConcepts).toBe(6);
  });
});

describe("the picture, once there is enough behind it", () => {
  const measured = (() => {
    const rows: ReadinessConcept[] = [
      concept("c-1", "SECURE", 0.91),
      concept("c-2", "SECURE", 0.85),
      concept("c-3", "DEVELOPING", 0.7),
      concept("c-4", "FRAGILE", 0.45),
      concept("c-5", "CRITICAL", 0.2),
      concept("c-6", "CRITICAL", 0.31),
    ];
    const chaptersByConcept = new Map(
      rows.map((row, index) => [row.conceptId, [`ch-${index + 1}`]]),
    );
    return { rows, chaptersByConcept };
  })();

  function drawn(overrides: Partial<ReadinessInput> = {}) {
    const result = buildReadiness(
      input({
        chapters: chapters(10),
        syllabusConceptIds: [...measured.rows.map((row) => row.conceptId), "c-7"],
        concepts: measured.rows,
        chaptersByConcept: measured.chaptersByConcept,
        testedChapterIds: ["ch-1", "ch-2", "ch-3", "ch-4", "ch-5", "ch-6"],
        ...overrides,
      }),
    );
    if (!result.ok) throw new Error(`expected a picture: ${result.message}`);
    return result;
  }

  it("counts the bands and never rolls them into one number", () => {
    const result = drawn();

    expect(result.standing).toEqual({ secure: 2, developing: 1, needsWork: 3 });
    expect(result.coverage).toEqual({
      measuredConcepts: 6,
      totalConcepts: 7,
      measuredChapters: 6,
      testedChapters: 6,
      totalChapters: 10,
    });
  });

  it("has no composite score anywhere in it, at any depth", () => {
    // The number everybody asks for and the one that must not exist: an
    // average over concepts moves when the syllabus moves, and it is the
    // figure a class of children would compare. Per-concept estimates are
    // fine — those are what `estimate` is — and a roll-up is not.
    const banned = /^(score|percentage|percent|overall|readiness|rank|grade|average|mean)$/i;
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.push(key);
          walk(child);
        }
      }
    };
    walk(drawn());

    expect(keys.filter((key) => banned.test(key))).toEqual([]);
  });

  it("names the weakest first, and never on both sides", () => {
    const result = drawn();

    expect(result.attention.map((row) => row.conceptId)).toEqual([
      "c-5",
      "c-6",
      "c-4",
    ]);
    expect(result.strengths.map((row) => row.conceptId)).toEqual(["c-1", "c-2"]);

    // Listed as both the strongest and the weakest is a bug this codebase has
    // shipped twice, on the parent portal and in a report.
    const both = result.attention.filter((row) =>
      result.strengths.some((other) => other.conceptId === row.conceptId),
    );
    expect(both).toEqual([]);
  });

  it("leads with coverage and says what it does not cover", () => {
    const result = drawn();

    // The denominator is the context for every other number, so it is the
    // first sentence rather than a footnote.
    expect(result.summary.startsWith("We have measured 6 of the 7 ideas")).toBe(true);
    expect(result.summary).toContain("6 of the 10 chapters");
    expect(result.caveat).toContain("4");
    expect(result.caveat).toMatch(/about what has been set, not about you/i);
  });

  it("drops the caveat only when there is genuinely nothing left out", () => {
    const result = drawn({
      chapters: chapters(6),
      testedChapterIds: ["ch-1", "ch-2", "ch-3", "ch-4", "ch-5", "ch-6"],
    });

    expect(result.untested).toEqual([]);
    expect(result.caveat).toBeNull();
  });
});

describe("the two bars, and why there are two", () => {
  it("needs half the chapters, not just five concepts", () => {
    const rows = Array.from({ length: MIN_MEASURED_CONCEPTS + 2 }, (_, index) =>
      concept(`c-${index + 1}`, "SECURE", 0.9),
    );
    // Every one of them in the same chapter. Five concepts is a statement
    // about that chapter, and the student is not sitting that chapter.
    const chaptersByConcept = new Map(rows.map((row) => [row.conceptId, ["ch-1"]]));

    const result = buildReadiness(
      input({
        chapters: chapters(10),
        syllabusConceptIds: rows.map((row) => row.conceptId),
        concepts: rows,
        chaptersByConcept,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-thin");
    expect(result.coverage.measuredConcepts).toBe(MIN_MEASURED_CONCEPTS + 2);
    expect(result.coverage.measuredChapters).toBe(1);
  });

  it("needs five concepts, not just half the chapters", () => {
    const { concepts, chaptersByConcept } = oneConceptPerChapter(3, "SECURE", 0.9);

    const result = buildReadiness(
      input({
        // Three of four chapters clears the fraction on its own.
        chapters: chapters(4),
        syllabusConceptIds: concepts.map((row) => row.conceptId),
        concepts,
        chaptersByConcept,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-thin");
  });

  it("rounds the chapter bar up, so a small syllabus is not a free pass", () => {
    expect(chaptersNeeded(51)).toBe(26);
    expect(chaptersNeeded(14)).toBe(7);
    expect(chaptersNeeded(1)).toBe(1);
    expect(chaptersNeeded(0)).toBe(0);
  });
});

describe("tested and measured are different questions", () => {
  it("lists a chapter measured only by practice as untested, and says so", () => {
    const { concepts, chaptersByConcept } = oneConceptPerChapter(8, "SECURE", 0.9);

    const result = buildReadiness(
      input({
        chapters: chapters(10),
        syllabusConceptIds: concepts.map((row) => row.conceptId),
        concepts,
        chaptersByConcept,
        // Practice IS evidence, at a reduced weight, so a student can measure
        // a chapter at home that no paper has ever asked about. "No test you
        // have sat has covered this" is still exactly true, and still the
        // thing to take to a teacher.
        testedChapterIds: [],
      }),
    );

    if (!result.ok) throw new Error(`expected a picture: ${result.message}`);
    expect(result.coverage.measuredChapters).toBe(8);
    expect(result.coverage.testedChapters).toBe(0);
    expect(result.untested).toHaveLength(10);
  });

  it("keeps the chapters in the order they arrived", () => {
    const result = buildReadiness(
      input({ chapters: chapters(3), testedChapterIds: [] }),
    );

    // A list that reshuffles between two page loads is one a student cannot
    // compare against what they saw yesterday.
    expect(result.untested.map((row) => row.number)).toEqual([1, 2, 3]);
  });
});
