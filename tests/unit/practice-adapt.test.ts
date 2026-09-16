import { describe, expect, it } from "vitest";
import {
  nextDifficulty,
  pickNearest,
  RUN_TO_STEP,
  type Difficulty,
  type Verdict,
} from "@/core/practice/adapt";

const run = (...pairs: [Difficulty, boolean][]): Verdict[] =>
  pairs.map(([difficulty, correct]) => ({ difficulty, correct }));

describe("it moves on a run, not on one answer", () => {
  it("opens at the level the set was calibrated for", () => {
    expect(nextDifficulty("EASY", [])).toEqual({ next: "EASY", reason: "start" });
    expect(nextDifficulty("MEDIUM", [])).toEqual({ next: "MEDIUM", reason: "start" });
  });

  it("holds after a single right answer", () => {
    // Stepping on one answer makes the set sawtooth: right, harder, wrong,
    // easier. A student gets oscillation instead of a direction.
    expect(nextDifficulty("EASY", run(["EASY", true]))).toEqual({
      next: "EASY",
      reason: "steady",
    });
  });

  it("holds after a single wrong answer", () => {
    expect(nextDifficulty("MEDIUM", run(["MEDIUM", false]))).toEqual({
      next: "MEDIUM",
      reason: "steady",
    });
  });

  it("steps up after two right", () => {
    expect(
      nextDifficulty("MEDIUM", run(["MEDIUM", true], ["MEDIUM", true])),
    ).toEqual({ next: "HARD", reason: "harder" });
  });

  it("steps down after two wrong", () => {
    expect(
      nextDifficulty("MEDIUM", run(["MEDIUM", false], ["MEDIUM", false])),
    ).toEqual({ next: "EASY", reason: "easier" });
  });

  it("holds on a mixed pair", () => {
    expect(
      nextDifficulty("MEDIUM", run(["MEDIUM", true], ["MEDIUM", false])),
    ).toEqual({ next: "MEDIUM", reason: "steady" });
  });

  it("only reads the last two", () => {
    // A student who has turned it around should not be held back by the start
    // of the set.
    expect(
      nextDifficulty(
        "MEDIUM",
        run(["MEDIUM", false], ["MEDIUM", false], ["EASY", true], ["EASY", true]),
      ).reason,
    ).toBe("harder");
    expect(RUN_TO_STEP).toBe(2);
  });
});

describe("the ceiling and the floor", () => {
  it("never goes above one step past where the set started", () => {
    // The session is about the concept, not about climbing a ladder — and a
    // student put on EASY because they are at 0.3 has not earned HARD by
    // getting two easy questions right.
    const after = nextDifficulty("EASY", run(["EASY", true], ["EASY", true]));
    expect(after.next).toBe("MEDIUM");

    const again = nextDifficulty(
      "EASY",
      run(["EASY", true], ["EASY", true], ["MEDIUM", true], ["MEDIUM", true]),
    );
    expect(again.next).toBe("MEDIUM");
    expect(again.reason).toBe("steady");
  });

  it("lets a set that started higher reach HARD", () => {
    expect(
      nextDifficulty("MEDIUM", run(["MEDIUM", true], ["MEDIUM", true])).next,
    ).toBe("HARD");
  });

  it("stops at EASY on the way down", () => {
    const after = nextDifficulty("MEDIUM", run(["EASY", false], ["EASY", false]));
    expect(after.next).toBe("EASY");
    expect(after.reason).toBe("steady");
  });

  it("drops faster than it climbs, from the same start", () => {
    // Not symmetric, deliberately. A run they cannot do is how somebody decides
    // they are bad at the subject and closes the tab; there is no floor beyond
    // EASY, but there is a ceiling on the way up.
    const down = nextDifficulty("HARD", run(["HARD", false], ["HARD", false]));
    expect(down.next).toBe("MEDIUM");

    const up = nextDifficulty("EASY", run(["MEDIUM", true], ["MEDIUM", true]));
    // Capped at base + 1, so it cannot run away from a struggling student.
    expect(up.next).toBe("MEDIUM");
  });
});

describe("picking from what the bank holds", () => {
  const pool = [
    { id: "e", difficulty: "EASY" as Difficulty },
    { id: "m", difficulty: "MEDIUM" as Difficulty },
    { id: "h", difficulty: "HARD" as Difficulty },
  ];

  it("takes the level asked for when it exists", () => {
    expect(pickNearest("MEDIUM", pool)!.id).toBe("m");
  });

  it("falls back to the nearest rather than ending the set", () => {
    // A concept with no HARD questions must still serve a next question.
    expect(pickNearest("HARD", [pool[0]!, pool[1]!])!.id).toBe("m");
    expect(pickNearest("EASY", [pool[1]!, pool[2]!])!.id).toBe("m");
  });

  it("breaks a tie downwards", () => {
    // Serving a HARDER question than asked for, because the bank was short, is
    // the one direction this must not drift in.
    expect(pickNearest("MEDIUM", [pool[0]!, pool[2]!])!.id).toBe("e");
  });

  it("returns null on an empty pool rather than throwing", () => {
    expect(pickNearest("MEDIUM", [])).toBeNull();
  });
});
