import { describe, expect, it } from "vitest";
import { pickWorksheet } from "@/core/gaps/reteach";
import { extendedMinutes, EXTRA_TIME_OPTIONS } from "@/core/roster/accommodations";
import { reviewStatus } from "@/core/assessments/review";
import { sharedWrong } from "@/core/results";

describe("a reteach worksheet", () => {
  const q = (id: string, difficulty: "EASY" | "MEDIUM" | "HARD") => ({ id, difficulty });

  it("prefers questions the class has not met, then prints easiest first", () => {
    const picked = pickWorksheet(
      [q("seen-easy", "EASY"), q("hard", "HARD"), q("easy", "EASY"), q("medium", "MEDIUM")],
      new Set(["seen-easy"]),
      3,
    );
    expect(picked).toEqual(["easy", "medium", "hard"]);
  });

  it("uses seen questions when there are not enough unseen ones", () => {
    expect(pickWorksheet([q("a", "EASY"), q("b", "MEDIUM")], new Set(["a"]), 5)).toEqual(["a", "b"]);
  });
});

describe("extra time", () => {
  it("rounds up, so it is never shaved", () => {
    expect(extendedMinutes(45, 0)).toBe(45);
    expect(extendedMinutes(45, 33)).toBe(60);
    expect(extendedMinutes(40, 25)).toBe(50);
    expect(extendedMinutes(7, 25)).toBe(9);
  });

  it("offers CBSE's twenty minutes an hour", () => {
    expect(EXTRA_TIME_OPTIONS).toContain(33);
    expect(extendedMinutes(180, 33)).toBeGreaterThanOrEqual(180 + 59);
  });
});

describe("a paper's review status", () => {
  it("is read from the stamps", () => {
    expect(reviewStatus({ reviewRequestedAt: null, reviewDecision: null })).toBe("NOT_SENT");
    expect(reviewStatus({ reviewRequestedAt: new Date(), reviewDecision: null })).toBe("WAITING");
    expect(reviewStatus({ reviewRequestedAt: new Date(), reviewDecision: "APPROVED" })).toBe("APPROVED");
    expect(reviewStatus({ reviewRequestedAt: new Date(), reviewDecision: "CHANGES_REQUESTED" })).toBe(
      "CHANGES_REQUESTED",
    );
  });
});

describe("a shared wrong answer", () => {
  const option = (key: string, chosen: number) => ({ key, text: `Option ${key}`, isCorrect: false, chosen });
  const answer = (key: string, name: string) => ({ response: { kind: "choice", keys: [key] }, name });

  it("names who chose it, once two and a fifth of the class did", () => {
    const rows = sharedWrong(
      [option("B", 3), option("C", 1)],
      [answer("B", "Rohan"), answer("B", "Kavya"), answer("B", "Asha"), answer("C", "Dev"), answer("A", "Meera")],
      5,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "B", chosen: 3, names: ["Asha", "Kavya", "Rohan"] });
  });

  it("stays quiet about one student's slip, and about a sliver of a big class", () => {
    expect(sharedWrong([option("B", 1)], [answer("B", "Rohan")], 4)).toEqual([]);
    expect(sharedWrong([option("B", 2)], [answer("B", "A"), answer("B", "B")], 30)).toEqual([]);
  });
});
