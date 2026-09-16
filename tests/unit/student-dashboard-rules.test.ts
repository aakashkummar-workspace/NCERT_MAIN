import { describe, expect, it } from "vitest";
import {
  conceptSnapshot,
  EFFORT_DAYS,
  effortSince,
  hasNewFeedback,
  kolkataDaysAgo,
  maskPhone,
  questionsToReview,
  resultMarks,
} from "@/core/student/rules";

const NOW = new Date("2026-09-15T09:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe("the effort window", () => {
  it("is a rolling seven days, not a week that resets on Monday", () => {
    expect(EFFORT_DAYS).toBe(7);
    expect(NOW.getTime() - effortSince(NOW).getTime()).toBe(7 * 86_400_000);
    // A Monday morning still reaches back into the weekend's work.
    const monday = new Date("2026-09-14T00:30:00+05:30");
    expect(effortSince(monday).toISOString()).toBe("2026-09-06T19:00:00.000Z");
  });
});

describe("masking a guardian's number", () => {
  it("keeps the first two and last three digits", () => {
    expect(maskPhone("9812345210")).toBe("98•••••210");
    expect(maskPhone("+91 98123-45210")).toBe("98•••••210");
  });

  it("returns nothing rather than half-masking something malformed", () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("")).toBeNull();
    expect(maskPhone("12345")).toBeNull();
  });
});

describe("new feedback", () => {
  it("is new when the result was never opened", () => {
    expect(hasNewFeedback([minutes(-10)], null)).toBe(true);
    expect(hasNewFeedback([null], null)).toBe(true);
  });

  it("is not new when the student opened the result after it was written", () => {
    expect(hasNewFeedback([minutes(-10)], minutes(-5))).toBe(false);
  });

  it("is new again when the teacher writes after the student looked", () => {
    expect(hasNewFeedback([minutes(-10), minutes(-1)], minutes(-5))).toBe(true);
  });

  it("is nothing when there is no comment, and an undated comment already seen stays seen", () => {
    expect(hasNewFeedback([], null)).toBe(false);
    expect(hasNewFeedback([null], minutes(-5))).toBe(false);
  });
});

describe("the latest result's headline", () => {
  it("prints a final figure once nothing is pending", () => {
    expect(
      resultMarks({ rawScore: 7, maxScore: 10, pendingMarks: 0, breakdown: [{ awardedMarks: 7 }] }),
    ).toEqual({ kind: "final", awarded: 7, total: 10 });
  });

  it("says 'so far' when some marks are still with the teacher", () => {
    expect(
      resultMarks({
        rawScore: 2,
        maxScore: 5,
        pendingMarks: 3,
        breakdown: [{ awardedMarks: 2 }, { awardedMarks: null }],
      }),
    ).toEqual({ kind: "so-far", awarded: 2, total: 5, pending: 3 });
  });

  it("never turns an unmarked paper into a zero", () => {
    expect(
      resultMarks({ rawScore: 0, maxScore: 5, pendingMarks: 5, breakdown: [{ awardedMarks: null }] }),
    ).toEqual({ kind: "unmarked", total: 5, pending: 5 });
  });

  it("counts marked questions short of full marks, and blanks, but not unmarked answers", () => {
    expect(
      questionsToReview([
        { awardedMarks: 1, marks: 1, answered: true },
        { awardedMarks: 0, marks: 1, answered: true },
        { awardedMarks: 1, marks: 3, answered: true },
        { awardedMarks: null, marks: 1, answered: false },
        { awardedMarks: null, marks: 3, answered: true },
      ]),
    ).toBe(3);
  });
});

describe("the concept snapshot", () => {
  const base = { openMistakes: 0, lastEvidenceAt: NOW, available: 10 };

  it("counts bands per subject and names the weakest measured, unsecured concept", () => {
    const snapshot = conceptSnapshot([
      { ...base, conceptId: "a", conceptName: "Ratio", estimate: 0.85, band: "SECURE", subjectNames: ["Mathematics"] },
      { ...base, conceptId: "b", conceptName: "Area", estimate: 0.7, band: "DEVELOPING", subjectNames: ["Mathematics"] },
      { ...base, conceptId: "c", conceptName: "Similarity", estimate: 0.3, band: "CRITICAL", subjectNames: ["Mathematics"] },
      { ...base, conceptId: "d", conceptName: "Probability", estimate: 0.5, band: "FRAGILE", subjectNames: ["Mathematics"], available: 2 },
      { ...base, conceptId: "e", conceptName: "Unmeasured", estimate: null, band: "INSUFFICIENT", subjectNames: ["Mathematics"] },
      { ...base, conceptId: "f", conceptName: "Cells", estimate: null, band: "INSUFFICIENT", subjectNames: ["Biology"] },
    ]);

    expect(snapshot.map((row) => row.subjectName)).toEqual(["Biology", "Mathematics"]);
    const maths = snapshot[1]!;
    expect(maths).toMatchObject({ secure: 1, almostThere: 1, needsPractice: 2, notEnoughEvidence: 1 });
    expect(maths.weakest).toEqual({ conceptId: "c", conceptName: "Similarity", canPractise: true });

    // Nothing measured is not "weak": no concept is named.
    expect(snapshot[0]!.weakest).toBeNull();
    expect(snapshot[0]!.notEnoughEvidence).toBe(1);
  });

  it("names nothing when everything measured is secure, and refuses a practise link onto an empty bank", () => {
    const allSecure = conceptSnapshot([
      { ...base, conceptId: "a", conceptName: "Ratio", estimate: 0.9, band: "SECURE", subjectNames: ["Mathematics"] },
    ]);
    expect(allSecure[0]!.weakest).toBeNull();

    const thinBank = conceptSnapshot([
      { ...base, conceptId: "a", conceptName: "Ratio", estimate: 0.2, band: "CRITICAL", subjectNames: ["Mathematics"], available: 3 },
    ]);
    expect(thinBank[0]!.weakest?.canPractise).toBe(false);
  });

  it("never counts a row with no estimate as measured, whatever its band says", () => {
    const snapshot = conceptSnapshot([
      { ...base, conceptId: "a", conceptName: "Ratio", estimate: null, band: "CRITICAL", subjectNames: ["Mathematics"] },
    ]);
    expect(snapshot[0]).toMatchObject({ needsPractice: 0, notEnoughEvidence: 1, weakest: null });
  });
});

describe("announcement dates", () => {
  it("counts calendar days in India", () => {
    const now = new Date("2026-09-15T00:10:00+05:30");
    expect(kolkataDaysAgo(new Date("2026-09-14T23:50:00+05:30"), now)).toBe(1);
    expect(kolkataDaysAgo(new Date("2026-09-15T00:01:00+05:30"), now)).toBe(0);
    expect(kolkataDaysAgo(new Date("2026-09-16T00:01:00+05:30"), now)).toBe(0);
  });
});
