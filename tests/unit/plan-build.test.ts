import { describe, expect, it } from "vitest";
import {
  buildPlan,
  MAX_ITEMS,
  MAX_PRACTICE_ITEMS,
  REVISE_WINDOW_DAYS,
  type PlanConcept,
  type PlanTest,
  whenPhrase,
} from "@/core/plan/build";

const NOW = new Date("2026-09-09T09:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function concept(over: Partial<PlanConcept> = {}): PlanConcept {
  return {
    conceptId: over.conceptId ?? "c1",
    conceptName: over.conceptName ?? "Similarity of triangles",
    estimate: over.estimate === undefined ? 0.3 : over.estimate,
    band: over.band ?? "CRITICAL",
    openMistakes: over.openMistakes ?? 0,
    lastEvidenceAt: over.lastEvidenceAt === undefined ? days(-2) : over.lastEvidenceAt,
    available: over.available ?? 10,
    subjectNames: over.subjectNames ?? ["Mathematics"],
  };
}

function test(over: Partial<PlanTest> = {}): PlanTest {
  return {
    assignmentId: over.assignmentId ?? "a1",
    title: over.title ?? "Unit test 3",
    subjectName: over.subjectName ?? "Mathematics",
    opensAt: over.opensAt ?? days(2),
    closesAt: over.closesAt ?? days(3),
    status: over.status ?? "SCHEDULED",
    canStart: over.canStart ?? false,
    inProgressAttemptId: over.inProgressAttemptId ?? null,
    attemptsUsed: over.attemptsUsed ?? 0,
  };
}

describe("the plan refuses", () => {
  it("says nothing-yet when nothing is measured", () => {
    const plan = buildPlan(
      { tests: [], concepts: [concept({ estimate: null, band: "INSUFFICIENT" })], openMistakes: 0 },
      NOW,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("nothing-yet");
    // The instruction, not an apology.
    expect(plan.message).toMatch(/sat a test/i);
  });

  it("says all-clear when there is genuinely nothing to fix", () => {
    const plan = buildPlan(
      {
        tests: [],
        concepts: [concept({ estimate: 0.9, band: "SECURE" })],
        openMistakes: 0,
      },
      NOW,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    // Opposite facts, and they must never share a sentence: one means "we know
    // nothing about you", the other means "we know, and you are fine".
    expect(plan.reason).toBe("all-clear");
    expect(plan.message).not.toMatch(/sat a test/i);
  });

  it("never offers a secure concept as something to do", () => {
    const plan = buildPlan(
      {
        tests: [],
        concepts: [
          concept({ conceptId: "c1", estimate: 0.9, band: "SECURE" }),
          concept({ conceptId: "c2", conceptName: "Ratio", estimate: 0.85, band: "SECURE" }),
        ],
        openMistakes: 0,
      },
      NOW,
    );
    // "Here if you want to keep it that way" is an offer. A plan is what you
    // should do, and putting maintenance in it teaches a student that the plan
    // is optional.
    expect(plan.ok).toBe(false);
  });
});

describe("deadlines come first and are not capped", () => {
  it("puts an unfinished sitting above everything", () => {
    const plan = buildPlan(
      {
        tests: [
          test({ status: "OPEN", canStart: true, inProgressAttemptId: "att-1" }),
        ],
        concepts: [concept()],
        openMistakes: 4,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.items[0]!.kind).toBe("resume-test");
    expect(plan.items[0]!.href).toBe("/student/attempt/att-1");
  });

  it("does not also tell them to start a paper they are already in", () => {
    const plan = buildPlan(
      {
        tests: [
          test({ status: "OPEN", canStart: true, inProgressAttemptId: "att-1" }),
        ],
        concepts: [concept()],
        openMistakes: 0,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.items.filter((item) => item.kind === "sit-test")).toHaveLength(0);
  });

  it("keeps every open paper even past the item cap", () => {
    const tests = Array.from({ length: 7 }, (_, index) =>
      test({
        assignmentId: `a${index}`,
        title: `Paper ${index}`,
        status: "OPEN",
        canStart: true,
      }),
    );
    const plan = buildPlan({ tests, concepts: [concept()], openMistakes: 3 }, NOW);
    if (!plan.ok) throw new Error("expected a plan");

    // Seven papers open this week IS the plan. Padding it with practice would
    // be the product competing with the teacher for the same evening.
    expect(plan.items.filter((item) => item.deadline)).toHaveLength(7);
    expect(plan.items.every((item) => item.deadline)).toBe(true);
  });

  it("never offers a paper whose window is shut", () => {
    const plan = buildPlan(
      {
        tests: [test({ status: "CLOSED", canStart: false })],
        concepts: [concept()],
        openMistakes: 0,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.items.some((item) => item.kind === "sit-test")).toBe(false);
  });

  it("never offers a paper they have used every attempt on", () => {
    const plan = buildPlan(
      {
        tests: [test({ status: "OPEN", canStart: false })],
        concepts: [concept()],
        openMistakes: 0,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.items.some((item) => item.kind === "sit-test")).toBe(false);
  });
});

describe("revising for a coming test", () => {
  it("names the weakest concept in that subject, with the number", () => {
    const plan = buildPlan(
      {
        tests: [test({ status: "SCHEDULED", opensAt: days(3) })],
        concepts: [
          concept({ conceptId: "c1", conceptName: "Similarity", estimate: 0.55 }),
          concept({ conceptId: "c2", conceptName: "Ratio", estimate: 0.25 }),
        ],
        openMistakes: 0,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    const revise = plan.items.find((item) => item.kind === "revise-for-test");
    expect(revise?.conceptId).toBe("c2");
    // The number is in the sentence. "You are weak at this" is an accusation;
    // "about 25% right so far" is a fact they can check.
    expect(revise?.why).toContain("25%");
    expect(revise?.why).toContain("Mathematics");
  });

  it("does not reach across subjects", () => {
    const plan = buildPlan(
      {
        tests: [test({ subjectName: "Science", opensAt: days(2) })],
        concepts: [concept({ subjectNames: ["Mathematics"], estimate: 0.2 })],
        openMistakes: 0,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    // Sending somebody to revise maths before a science test is worse than
    // saying nothing.
    expect(plan.items.some((item) => item.kind === "revise-for-test")).toBe(false);
  });

  it("ignores a test further out than the revision window", () => {
    const plan = buildPlan(
      {
        tests: [test({ opensAt: days(REVISE_WINDOW_DAYS + 3) })],
        concepts: [concept({ estimate: 0.2 })],
        openMistakes: 0,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    // Three weeks of "revise for your test" at the top of the plan teaches the
    // student to stop reading the top of the plan.
    expect(plan.items.some((item) => item.kind === "revise-for-test")).toBe(false);
  });

  it("says nothing when every concept in that subject is fine", () => {
    // An unrelated mistake, so the plan has a body and the assertion is about
    // the revise item rather than about the plan being empty.
    const plan = buildPlan(
      {
        tests: [test({ opensAt: days(2) })],
        concepts: [concept({ estimate: 0.85, band: "SECURE" })],
        openMistakes: 1,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    // Practising something they can already do, the night before a test, costs
    // them the evening they needed for something else.
    expect(plan.items.some((item) => item.kind === "revise-for-test")).toBe(false);
  });

  it("says nothing when the weakest concept is unmeasured", () => {
    const plan = buildPlan(
      {
        tests: [test({ opensAt: days(2) })],
        concepts: [concept({ estimate: null, band: "INSUFFICIENT" })],
        openMistakes: 0,
      },
      NOW,
    );
    expect(plan.ok).toBe(false);
  });

  it("says nothing when there are not enough questions to practise", () => {
    const plan = buildPlan(
      {
        tests: [test({ opensAt: days(2) })],
        concepts: [concept({ estimate: 0.2, available: 2 })],
        openMistakes: 1,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    // Naming a concept and handing them an empty set is worse than silence:
    // they have already spent the tap.
    expect(plan.items.some((item) => item.kind === "revise-for-test")).toBe(false);
  });
});

describe("the discretionary half", () => {
  it("collapses every open mistake into one item", () => {
    const plan = buildPlan(
      {
        tests: [],
        concepts: [
          concept({ conceptId: "c1", openMistakes: 2 }),
          concept({ conceptId: "c2", conceptName: "Ratio", openMistakes: 3 }),
        ],
        openMistakes: 5,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    const fixes = plan.items.filter((item) => item.kind === "fix-mistakes");
    // The bank is already a list. A plan that reproduces it is two lists.
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.title).toContain("5");
  });

  it("reads correctly for exactly one mistake", () => {
    const plan = buildPlan(
      { tests: [], concepts: [concept({ openMistakes: 1 })], openMistakes: 1 },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    const fix = plan.items.find((item) => item.kind === "fix-mistakes");
    expect(fix?.title).not.toMatch(/\d/);
    expect(fix?.title).toMatch(/the question/i);
  });

  it("caps practice items so the plan is not five identical cards", () => {
    const concepts = Array.from({ length: 6 }, (_, index) =>
      concept({
        conceptId: `c${index}`,
        conceptName: `Concept ${index}`,
        estimate: 0.2 + index * 0.05,
      }),
    );
    const plan = buildPlan({ tests: [], concepts, openMistakes: 0 }, NOW);
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.items.filter((item) => item.kind === "practise").length).toBeLessThanOrEqual(
      MAX_PRACTICE_ITEMS,
    );
  });

  it("never names the same concept twice", () => {
    const plan = buildPlan(
      {
        tests: [test({ opensAt: days(2) })],
        concepts: [
          concept({ conceptId: "c1", conceptName: "Similarity", estimate: 0.2 }),
          concept({ conceptId: "c2", conceptName: "Ratio", estimate: 0.5 }),
        ],
        openMistakes: 0,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    const named = plan.items
      .map((item) => item.conceptId)
      .filter((id): id is string => id !== null);
    // The same concept under two headings is the page arguing with itself —
    // the duplicate-card bug the practice page already had once.
    expect(new Set(named).size).toBe(named.length);
  });

  it("keeps the whole plan within the cap when there are few deadlines", () => {
    const concepts = Array.from({ length: 8 }, (_, index) =>
      concept({
        conceptId: `c${index}`,
        conceptName: `Concept ${index}`,
        estimate: 0.2 + index * 0.04,
      }),
    );
    const plan = buildPlan(
      {
        tests: [test({ status: "OPEN", canStart: true })],
        concepts,
        openMistakes: 3,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.items.length).toBeLessThanOrEqual(MAX_ITEMS);
  });
});

describe("every item can be acted on", () => {
  it("carries a destination and a label, always", () => {
    const plan = buildPlan(
      {
        tests: [
          test({ status: "OPEN", canStart: true, inProgressAttemptId: "att-1" }),
          test({ assignmentId: "a2", title: "Paper 2", status: "OPEN", canStart: true }),
          test({ assignmentId: "a3", title: "Paper 3", opensAt: days(2) }),
        ],
        concepts: [concept({ estimate: 0.2 })],
        openMistakes: 2,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    for (const item of plan.items) {
      // An item with nowhere to go is a reproach, which is the one thing a
      // study plan must never be.
      // Under the student surface: a page, or a card on Home.
      expect(item.href).toMatch(/^[/]student[/#]/);
      expect(item.actionLabel.length).toBeGreaterThan(0);
      expect(item.why.length).toBeGreaterThan(0);
      expect(item.title.length).toBeGreaterThan(0);
    }
  });

  it("says when a window shuts, in words rather than a date", () => {
    const plan = buildPlan(
      {
        tests: [
          test({ status: "OPEN", canStart: true, closesAt: days(1.2) }),
        ],
        concepts: [concept()],
        openMistakes: 0,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    // A date needs a calendar; "tomorrow" needs nothing.
    expect(plan.items[0]!.why).toMatch(/tomorrow/);
    expect(plan.items[0]!.why).not.toMatch(/2026/);
  });

  it("counts calendar days in India, not 24-hour blocks", () => {
    // 14:30 IST now. 47 hours on is 13:30 IST two days later — "in 2 days",
    // as Home says, where 24-hour blocks said "tomorrow".
    expect(whenPhrase(new Date(NOW.getTime() + 47 * 3_600_000), NOW)).toBe("in 2 days");
    // 18 hours on is 08:30 IST tomorrow morning — not "today".
    expect(whenPhrase(new Date(NOW.getTime() + 18 * 3_600_000), NOW)).toBe("tomorrow");
    // Five hours on is still today in Kolkata.
    expect(whenPhrase(new Date(NOW.getTime() + 5 * 3_600_000), NOW)).toBe("today");
    // Past is not a phrase at all, so nothing can print "shuts already".
    expect(whenPhrase(days(-1), NOW)).toBeNull();
  });

  it("links Start to the paper's card, where starting actually happens", () => {
    const plan = buildPlan(
      { tests: [test({ status: "OPEN", canStart: true })], concepts: [concept()], openMistakes: 0 },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    const sit = plan.items.find((item) => item.kind === "sit-test")!;
    // `/student/tests/…` was a route that never existed.
    expect(sit.href).toBe("/student#test-a1");
  });

  it("stops saying Sit once a paper has been sat, even with an attempt left", () => {
    const plan = buildPlan(
      {
        tests: [test({ status: "OPEN", canStart: true, attemptsUsed: 1 })],
        concepts: [concept()],
        openMistakes: 0,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.items.some((item) => item.kind === "sit-test")).toBe(false);
  });

  it("holds no dates or durations anywhere", () => {
    const plan = buildPlan(
      {
        tests: [test({ status: "OPEN", canStart: true }), test({ assignmentId: "a2", opensAt: days(2) })],
        concepts: [concept({ estimate: 0.2 })],
        openMistakes: 1,
      },
      NOW,
    );
    if (!plan.ok) throw new Error("expected a plan");
    const text = plan.items.map((item) => `${item.title} ${item.why}`).join(" ");
    // A plan is an order, never a timetable. "Monday: 30 minutes" is a promise
    // about somebody else's evening that this product cannot keep, and it is
    // wrong by Tuesday.
    expect(text).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    expect(text).not.toMatch(/\bminutes?\b|\bhours?\b/i);
    expect(text).not.toMatch(/\bMonday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday\b/);
  });
});
