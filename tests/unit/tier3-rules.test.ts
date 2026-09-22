import { describe, expect, it } from "vitest";
import { buildDigest, weekOf } from "@/core/digest/build";
import { buildMeetingBrief } from "@/core/reports/meeting";
import type { ReportInput } from "@/core/reports/build";
import { buildParameters, render } from "@/whatsapp/templates";

const day = 24 * 3600_000;
const now = new Date("2026-09-20T12:00:00Z");

describe("the weekly WhatsApp digest", () => {
  const view = (satDaysAgo: number, released = true) => ({
    fullName: "Kavya Iyer",
    sittings: [
      {
        title: "Triangles unit test",
        satAt: new Date(now.getTime() - satDaysAgo * day),
        percentage: released ? 80 : null,
        marks: released ? { awarded: 4, total: 5, awaitingMarking: 0 } : null,
        fullyMarked: true,
      },
    ],
    attention: [{ conceptName: "Similarity of triangles", estimate: 0.3 }],
  });

  it("says the result and one idea, and never a score of its own", () => {
    const message = buildDigest(view(2), new Date(now.getTime() - 7 * day), "https://x/parent");
    expect(message).toEqual({
      send: true,
      values: ["Kavya", "Triangles unit test 4 of 5", "Similarity of triangles", "https://x/parent"],
    });
  });

  it("sends nothing in a week with nothing new", () => {
    expect(buildDigest(view(10), new Date(now.getTime() - 7 * day), "u").send).toBe(false);
    expect(buildDigest(view(2, false), new Date(now.getTime() - 7 * day), "u").send).toBe(false);
  });

  it("dates each digest to its week's Monday, in IST", () => {
    // Sunday 20 Sept 2026 → Monday 14 Sept.
    expect(weekOf(now).toISOString().slice(0, 10)).toBe("2026-09-14");
    // Monday 00:30 IST is Sunday in UTC, and still the new week.
    expect(weekOf(new Date("2026-09-20T19:00:00Z")).toISOString().slice(0, 10)).toBe("2026-09-21");
  });

  it("fills the registered template exactly, one line per variable", () => {
    const parameters = buildParameters("WEEKLY_DIGEST", ["Kavya", "A\nB", "C", "D"]);
    expect(parameters[1]).toBe("A B");
    expect(render("WEEKLY_DIGEST", parameters)).toContain("This week for Kavya");
    expect(() => buildParameters("WEEKLY_DIGEST", ["one"])).toThrow();
  });
});

describe("the parent–teacher meeting brief", () => {
  const input = (concepts: ReportInput["concepts"]): ReportInput => ({
    studentName: "Rohan Das",
    className: "Class 10-A",
    periodStart: new Date("2026-04-01T00:00:00Z"),
    periodEnd: now,
    concepts,
    unmeasuredCount: 20,
    sittings: [],
    openingEstimates: new Map([["c1", 0.2]]),
  });
  const extras = {
    openMistakes: 3,
    resolvedMistakes: 1,
    practiceDone: 2,
    assignedOutstanding: 0,
    bookLines: new Map([["c1", "Mathematics, chapter 6 (Triangles), §6.4 Criteria"]]),
  };

  it("says a thin picture is thin instead of refusing", () => {
    const brief = buildMeetingBrief(input([]), extras);
    expect(brief.talkingPoints[0]).toMatch(/early picture/);
  });

  it("names strengths and needs, points home to the book, and carries no overall score", () => {
    const brief = buildMeetingBrief(
      input([
        { conceptId: "c1", conceptName: "Similarity", estimate: 0.35, band: "FRAGILE", evidenceCount: 6 },
        { conceptId: "c2", conceptName: "Trigonometry", estimate: 0.9, band: "SECURE", evidenceCount: 8 },
        { conceptId: "c3", conceptName: "AP", estimate: 0.6, band: "DEVELOPING", evidenceCount: 5 },
      ]),
      extras,
    );
    expect(brief.goingWell.map((c) => c.name)).toEqual(["Trigonometry"]);
    expect(brief.needsWork[0]).toMatchObject({ name: "Similarity", book: expect.stringContaining("§6.4") });
    expect(brief.improved.map((m) => m.name)).toEqual(["Similarity"]);
    expect(brief.atHome[0]).toMatch(/§6\.4/);
    expect(JSON.stringify(brief)).not.toMatch(/rank|overall|average/i);
  });
});
