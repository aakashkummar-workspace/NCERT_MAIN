import { describe, expect, it } from "vitest";
import {
  describeSubstitutions,
  istDate,
  mixForBank,
  normaliseMix,
  pickForMix,
  pickForSections,
  windowFor,
  type Candidate,
} from "@/core/assessments/auto-fill";

/**
 * A paper built from a sentence: the model decides the plan, and these rules
 * decide which approved questions fill it. Pure, so every rule is pinned here.
 */

function bank(chapter: string, count: number, over: Partial<Candidate> = {}): Candidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${chapter}-${index}`,
    type: "MCQ" as const,
    difficulty: "MEDIUM" as const,
    marks: 1,
    chapterId: chapter,
    ...over,
    ...(over.id ? {} : { id: `${chapter}-${over.difficulty ?? "MEDIUM"}-${over.type ?? "MCQ"}-${index}` }),
  }));
}

const ALL_MEDIUM = { EASY: 0, MEDIUM: 100, HARD: 0 };

describe("picking for a custom mix", () => {
  it("spreads a paper across the chapters it covers", () => {
    const candidates = [...bank("triangles", 10), ...bank("circles", 10)];
    const { picked, short } = pickForMix(candidates, { questionCount: 6, difficultyMix: ALL_MEDIUM, typeMix: { MCQ: 100 } }, "seed");
    expect(picked).toHaveLength(6);
    expect(short).toEqual([]);
    expect(picked.filter((row) => row.chapterId === "triangles")).toHaveLength(3);
    expect(picked.filter((row) => row.chapterId === "circles")).toHaveLength(3);
  });

  it("is the same paper for the same seed and a different one for another", () => {
    const candidates = [...bank("a", 15), ...bank("b", 15)];
    const plan = { questionCount: 8, difficultyMix: ALL_MEDIUM, typeMix: { MCQ: 100 } };
    const ids = (seed: string) => pickForMix(candidates, plan, seed).picked.map((row) => row.id).sort();
    expect(ids("one")).toEqual(ids("one"));
    expect(ids("one")).not.toEqual(ids("two"));
  });

  it("tops a short difficulty up from the nearest one, and says so", () => {
    const candidates = [...bank("a", 2, { difficulty: "HARD" }), ...bank("a", 20, { difficulty: "MEDIUM" })];
    const { picked, short, substitutions } = pickForMix(
      candidates,
      { questionCount: 10, difficultyMix: { EASY: 0, MEDIUM: 50, HARD: 50 }, typeMix: { MCQ: 100 } },
      "seed",
    );
    // Ten asked for, ten given: two hard, and three medium standing in.
    expect(picked).toHaveLength(10);
    expect(short).toEqual([]);
    expect(substitutions).toEqual([{ type: "MCQ", from: "HARD", to: "MEDIUM", count: 3 }]);
    expect(describeSubstitutions(substitutions)[0]).toMatch(/3 medium multiple-choice questions used in place of hard/);
  });

  it("goes easier on a tie, never harder than asked when it need not", () => {
    // Medium ran out; easy and hard are both one step away. Easy first.
    const candidates = [...bank("a", 1), ...bank("a", 5, { difficulty: "EASY" }), ...bank("a", 5, { difficulty: "HARD" })];
    const { substitutions } = pickForMix(
      candidates,
      { questionCount: 3, difficultyMix: { EASY: 0, MEDIUM: 100, HARD: 0 }, typeMix: { MCQ: 100 } },
      "seed",
    );
    expect(substitutions).toEqual([{ type: "MCQ", from: "MEDIUM", to: "EASY", count: 2 }]);
  });

  it("never stands in another TYPE, and reports what is still short", () => {
    const candidates = [...bank("a", 1, { type: "SA", marks: 3 }), ...bank("a", 20)];
    const { short } = pickForMix(
      candidates,
      { questionCount: 4, difficultyMix: ALL_MEDIUM, typeMix: { SA: 100 } },
      "seed",
    );
    // In the teacher's own numbers: four asked for, one in the bank.
    expect(short).toEqual([{ label: "medium short answer", wanted: 4, found: 1 }]);
  });

  it("never puts one question on a paper twice", () => {
    const candidates = bank("a", 5);
    const { picked } = pickForMix(candidates, { questionCount: 5, difficultyMix: ALL_MEDIUM, typeMix: { MCQ: 100 } }, "s");
    expect(new Set(picked.map((row) => row.id)).size).toBe(picked.length);
  });
});

describe("picking for a board pattern", () => {
  const sections = [
    { name: "A", title: "Objective", types: ["MCQ" as const], count: 3, marksEach: 1, internalChoices: 0 },
    { name: "B", title: "Short", types: ["SA" as const], count: 2, marksEach: 3, internalChoices: 1 },
  ];

  it("fills each section by its type and marks, and pairs an OR within it", () => {
    const candidates = [...bank("a", 5), ...bank("a", 4, { type: "SA", marks: 3 }), ...bank("b", 4, { type: "SA", marks: 2 })];
    const { picked, short } = pickForSections(candidates, sections, "seed");
    expect(short).toEqual([]);
    expect(picked.filter((row) => row.section === "A")).toHaveLength(3);
    const sectionB = picked.filter((row) => row.section === "B");
    // Two questions answered, one of them with an alternative: three rows.
    expect(sectionB).toHaveLength(3);
    expect(sectionB.every((row) => row.marks === 3 && row.type === "SA")).toBe(true);
    const paired = sectionB.filter((row) => row.choiceGroup !== null);
    expect(paired).toHaveLength(2);
    expect(paired[0]!.choiceGroup).toBe(paired[1]!.choiceGroup);
    // Adjacent, as `checkLayout` requires of an OR pair.
    const indexes = paired.map((row) => picked.indexOf(row));
    expect(Math.abs(indexes[0]! - indexes[1]!)).toBe(1);
  });

  it("names a section the bank cannot fill", () => {
    const { short } = pickForSections(bank("a", 5), sections, "seed");
    expect(short).toEqual([{ label: "Section B (3-mark short answer)", wanted: 2, found: 0 }]);
  });
});

describe("the mix the model asked for", () => {
  it("is normalised to exactly 100, keeping every key", () => {
    const mix = normaliseMix({ EASY: 1, MEDIUM: 1, HARD: 1 }, { EASY: 30, MEDIUM: 50, HARD: 20 });
    expect(mix.EASY + mix.MEDIUM + mix.HARD).toBe(100);
    expect(normaliseMix({ EASY: 0, MEDIUM: 80, HARD: 0 }, { EASY: 30, MEDIUM: 50, HARD: 20 })).toEqual({ EASY: 0, MEDIUM: 100, HARD: 0 });
  });

  it("falls back when the model gave nothing", () => {
    expect(normaliseMix({ EASY: 0, MEDIUM: 0, HARD: 0 }, { EASY: 30, MEDIUM: 50, HARD: 20 })).toEqual({ EASY: 30, MEDIUM: 50, HARD: 20 });
  });
});

describe("the window the teacher asked for", () => {
  // Tuesday 22 September 2026, 10:00 IST.
  const now = new Date("2026-09-22T04:30:00Z");

  it("closes 'due Friday' at 20:00 IST on Friday and opens now", () => {
    const window = windowFor(null, "2026-09-25", 45, now)!;
    expect(window.opensAt.toISOString()).toBe(now.toISOString());
    expect(window.closesAt.toISOString()).toBe("2026-09-25T14:30:00.000Z");
  });

  it("is dropped rather than bent when it is over, too short, or not a date", () => {
    expect(windowFor(null, "2026-09-21", 45, now)).toBeNull();
    // Opens at midnight on the day, closes at 20:00: a 21-hour paper does not fit.
    expect(windowFor("2026-09-24", "2026-09-24", 21 * 60, now)).toBeNull();
    expect(windowFor(null, "2026-02-31", 45, now)).toBeNull();
    expect(windowFor(null, "Friday", 45, now)).toBeNull();
    expect(windowFor(null, null, 45, now)).toBeNull();
  });

  it("reads a date as the start of that day in India", () => {
    expect(istDate("2026-09-25")!.toISOString()).toBe("2026-09-24T18:30:00.000Z");
  });
});

describe("a type the bank holds none of", () => {
  it("is dropped from the mix and its share given to the types that exist", () => {
    const { typeMix, dropped } = mixForBank({ MCQ: 80, VSA: 20 }, bank("a", 10));
    expect(typeMix).toEqual({ MCQ: 100 });
    expect(dropped).toEqual(["VSA"]);
  });

  it("is left alone when nothing at all matches, so the shortfall is still reported", () => {
    const { typeMix, dropped } = mixForBank({ SA: 100 }, bank("a", 10));
    expect(typeMix).toEqual({ SA: 100 });
    expect(dropped).toEqual([]);
  });
});
