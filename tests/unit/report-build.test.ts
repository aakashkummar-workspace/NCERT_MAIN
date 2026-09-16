import { describe, expect, it } from "vitest";
import {
  buildReport,
  MIN_MEASURED_FOR_REPORT,
  MIN_MOVEMENT,
  type ReportConcept,
  type ReportInput,
  type ReportSitting,
} from "@/core/reports/build";
import { unnamedCounts } from "@/ui/ReportSheet";

const START = new Date("2026-04-01T00:00:00Z");
const END = new Date("2026-09-30T00:00:00Z");

function concept(over: Partial<ReportConcept> = {}): ReportConcept {
  const estimate = over.estimate === undefined ? 0.7 : over.estimate;
  return {
    conceptId: over.conceptId ?? "c1",
    conceptName: over.conceptName ?? "Similarity of triangles",
    estimate,
    band: over.band ?? (estimate === null ? "INSUFFICIENT" : "DEVELOPING"),
    evidenceCount: over.evidenceCount ?? 8,
  };
}

function sitting(over: Partial<ReportSitting> = {}): ReportSitting {
  return {
    assignmentId: over.assignmentId ?? "a1",
    title: over.title ?? "Unit test 3",
    subjectName: over.subjectName ?? "Mathematics",
    satAt: over.satAt ?? new Date("2026-08-01T00:00:00Z"),
    attempts: over.attempts ?? 1,
    percentage: over.percentage === undefined ? 0.62 : over.percentage,
    awarded: over.awarded === undefined ? 18 : over.awarded,
    total: over.total === undefined ? 30 : over.total,
    fullyMarked: over.fullyMarked ?? true,
  };
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    studentName: over.studentName ?? "Anjali Sharma",
    className: over.className ?? "Class 10-A",
    periodStart: over.periodStart ?? START,
    periodEnd: over.periodEnd ?? END,
    concepts:
      over.concepts ??
      [
        concept({ conceptId: "c1", conceptName: "Similarity", estimate: 0.9 }),
        concept({ conceptId: "c2", conceptName: "Ratio", estimate: 0.7 }),
        concept({ conceptId: "c3", conceptName: "Trigonometry", estimate: 0.3 }),
      ],
    unmeasuredCount: over.unmeasuredCount ?? 6,
    sittings: over.sittings ?? [sitting()],
    openingEstimates: over.openingEstimates ?? new Map(),
  };
}

describe("a report refuses rather than being thin", () => {
  it("will not be generated with nothing measured", () => {
    const result = buildReport(input({ concepts: [], unmeasuredCount: 12 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-enough-measured");
    // The instruction, not an apology.
    expect(result.message).toMatch(/set a test/i);
  });

  it("will not be generated below the evidence bar", () => {
    const result = buildReport(
      input({
        concepts: [concept({ conceptId: "c1" }), concept({ conceptId: "c2" })],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A thin report is worse than none: it is a document, with a date on it,
    // that somebody will act on.
    expect(result.message).toContain(String(MIN_MEASURED_FOR_REPORT));
  });

  it("does not count an INSUFFICIENT concept towards the bar", () => {
    const result = buildReport(
      input({
        concepts: [
          concept({ conceptId: "c1", estimate: 0.8 }),
          concept({ conceptId: "c2", estimate: 0.7 }),
          // Null is not zero, and it is not evidence either.
          concept({ conceptId: "c3", estimate: null, band: "INSUFFICIENT" }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("there is no overall grade", () => {
  it("carries band counts and named concepts, never a single score", () => {
    const result = buildReport(input());
    if (!result.ok) throw new Error(result.message);

    const payload = result.payload as unknown as Record<string, unknown>;
    // The one number that must not exist. It moves when the syllabus moves,
    // invites ranking children, and hides which idea.
    for (const forbidden of ["overall", "grade", "score", "average", "total"]) {
      expect(Object.keys(payload)).not.toContain(forbidden);
    }
    expect(result.payload.standing.secure).toBe(1);
    expect(result.payload.standing.needsWork).toBe(1);
    expect(result.payload.strengths.length).toBeGreaterThan(0);
  });

  it("never lists a concept as both a strength and a worry", () => {
    const result = buildReport(
      input({
        concepts: [
          concept({ conceptId: "c1", conceptName: "Only one", estimate: 0.3 }),
          concept({ conceptId: "c2", conceptName: "Ratio", estimate: 0.35 }),
          concept({ conceptId: "c3", conceptName: "Areas", estimate: 0.4 }),
        ],
      }),
    );
    if (!result.ok) throw new Error(result.message);
    const strong = new Set(result.payload.strengths.map((c) => c.conceptId));
    for (const worry of result.payload.attention) {
      expect(strong.has(worry.conceptId)).toBe(false);
    }
  });
});

describe("coverage is the headline", () => {
  it("names how many ideas were never measured", () => {
    const result = buildReport(input({ unmeasuredCount: 6 }));
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.coverage.unmeasured).toBe(6);
    expect(result.payload.coverage.measured).toBe(3);
    // And says so in the sentence, above the marks. Otherwise a parent reads a
    // term's worth of confidence into four questions.
    expect(result.payload.summary).toContain("3 of the 9");
    expect(result.payload.summary).toMatch(/says nothing about them/i);
  });

  it("does not apologise when everything was covered", () => {
    const result = buildReport(input({ unmeasuredCount: 0 }));
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.coverage.unmeasured).toBe(0);
    expect(result.payload.summary).not.toMatch(/have not been tested/i);
  });
});

describe("improvement is only claimed where both readings exist", () => {
  it("reports a real rise with both numbers", () => {
    const result = buildReport(
      input({ openingEstimates: new Map([["c3", 0.1]]) }),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.improved).toHaveLength(1);
    expect(result.payload.improved[0]!.from).toBe(0.1);
    expect(result.payload.improved[0]!.to).toBe(0.3);
    expect(result.payload.summary).toMatch(/improved on Trigonometry/);
  });

  it("claims nothing when there was no opening reading", () => {
    const result = buildReport(input({ openingEstimates: new Map() }));
    if (!result.ok) throw new Error(result.message);
    // "Improved from nothing" is a first measurement, and calling it progress
    // is the most flattering lie this report could tell.
    expect(result.payload.improved).toHaveLength(0);
    expect(result.payload.slipped).toHaveLength(0);
  });

  it("ignores movement too small to be signal", () => {
    const result = buildReport(
      input({
        openingEstimates: new Map([["c3", 0.3 - (MIN_MOVEMENT - 0.01)]]),
      }),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.improved).toHaveLength(0);
  });

  it("reports a fall as readily as a rise", () => {
    const result = buildReport(
      input({ openingEstimates: new Map([["c3", 0.8]]) }),
    );
    if (!result.ok) throw new Error(result.message);
    // A report that only ever goes up is one nobody can act on.
    expect(result.payload.slipped).toHaveLength(1);
    expect(result.payload.summary).toMatch(/gone the other way/);
  });
});

describe("marks", () => {
  it("leaves an unreleased sitting out entirely", () => {
    const result = buildReport(
      input({
        sittings: [
          sitting({ assignmentId: "a1" }),
          sitting({ assignmentId: "a2", percentage: null, awarded: null }),
        ],
      }),
    );
    if (!result.ok) throw new Error(result.message);
    // A parent reading a mark before their child has seen it is the ambush the
    // release gate exists to prevent — not a blank row, absent.
    expect(result.payload.sittings).toHaveLength(1);
    expect(result.payload.sittings[0]!.assignmentId).toBe("a1");
  });

  it("says how many papers are still being marked", () => {
    const result = buildReport(
      input({
        sittings: [
          sitting({ assignmentId: "a1" }),
          sitting({ assignmentId: "a2", fullyMarked: false }),
        ],
      }),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.awaitingMarking).toBe(1);
    // Stated, never hidden. A figure over fully marked papers presented without
    // the count left out is a wrong figure, not a smaller one.
    expect(result.payload.summary).toMatch(/still being marked/);
  });
});

describe("what it tells the reader to do", () => {
  it("claims the superlative only once", () => {
    const result = buildReport(
      input({
        concepts: [
          concept({ conceptId: "c1", conceptName: "Alpha", estimate: 0.2 }),
          concept({ conceptId: "c2", conceptName: "Beta", estimate: 0.3 }),
          concept({ conceptId: "c3", conceptName: "Gamma", estimate: 0.35 }),
        ],
      }),
    );
    if (!result.ok) throw new Error(result.message);
    const superlatives = result.payload.suggestions.filter((line) =>
      /would gain the most/.test(line),
    );
    // Two sentences both claiming to be the one that would gain the most is
    // the kind of thing nobody notices in code and everybody notices on a
    // sheet they are handed. A screenshot caught it.
    expect(superlatives).toHaveLength(1);
  });

  it("names the concept and the number behind it", () => {
    const result = buildReport(input());
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.suggestions[0]).toContain("Trigonometry");
    expect(result.payload.suggestions[0]).toMatch(/30%/);
    expect(result.payload.suggestions[0]).toMatch(/8 answers/);
  });

  it("gives at most three, and never a reprimand", () => {
    const result = buildReport(
      input({
        concepts: Array.from({ length: 8 }, (_, index) =>
          concept({
            conceptId: `c${index}`,
            conceptName: `Concept ${index}`,
            estimate: 0.1 + index * 0.03,
          }),
        ),
      }),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.suggestions.length).toBeLessThanOrEqual(3);
    const text = result.payload.suggestions.join(" ").toLowerCase();
    for (const word of ["must", "failed", "poor", "lazy", "should have"]) {
      expect(text).not.toContain(word);
    }
  });

  it("has something to say when nothing needs fixing", () => {
    const result = buildReport(
      input({
        concepts: [
          concept({ conceptId: "c1", estimate: 0.9 }),
          concept({ conceptId: "c2", estimate: 0.85 }),
          concept({ conceptId: "c3", estimate: 0.82 }),
        ],
        openingEstimates: new Map([["c1", 0.5]]),
        unmeasuredCount: 0,
      }),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.suggestions.length).toBeGreaterThan(0);
    expect(result.payload.suggestions[0]).toMatch(/nothing here needs fixing/i);
  });

  it("tells the reader not to read it as the whole subject", () => {
    const result = buildReport(input({ unmeasuredCount: 6 }));
    if (!result.ok) throw new Error(result.message);
    expect(result.payload.suggestions.join(" ")).toMatch(/whole subject/i);
  });
});

describe("the payload is a document, not a view", () => {
  it("stores no derived float that a jsonb round trip could change", () => {
    const result = buildReport(input({ unmeasuredCount: 257 }));
    if (!result.ok) throw new Error(result.message);
    // A double does not necessarily survive Postgres's `numeric` intact, and a
    // stamped report that differs from itself on re-read is the one thing this
    // document may never do. The integers are the fact; the ratio is
    // presentation and is derived where it is shown.
    const coverage = result.payload.coverage as Record<string, unknown>;
    expect(Object.keys(coverage).sort()).toEqual(["measured", "unmeasured"]);
    expect(Number.isInteger(coverage.measured)).toBe(true);
    expect(Number.isInteger(coverage.unmeasured)).toBe(true);
  });

  it("stores dates as strings so it survives a round trip through JSON", () => {
    const result = buildReport(input());
    if (!result.ok) throw new Error(result.message);
    const reparsed = JSON.parse(JSON.stringify(result.payload));
    // It is written to a jsonb column and read back months later by code that
    // has changed. Anything that does not survive that is not a report.
    expect(reparsed.periodStart).toBe(START.toISOString());
    expect(reparsed.coverage.measured).toBe(3);
    expect(reparsed.summary).toBe(result.payload.summary);
  });
});

describe("a truncated list says it is truncated", () => {
  // Rohan's sheet said "4 need work" above three names. The count of what is
  // left out has to be derivable from the stored payload, so sheets written
  // before this was fixed say it too.
  const many = [
    concept({ conceptId: "w1", conceptName: "Weak one", estimate: 0.2 }),
    concept({ conceptId: "w2", conceptName: "Weak two", estimate: 0.3 }),
    concept({ conceptId: "w3", conceptName: "Weak three", estimate: 0.4 }),
    concept({ conceptId: "w4", conceptName: "Weak four", estimate: 0.5 }),
    concept({ conceptId: "s1", conceptName: "Strong one", estimate: 0.9 }),
    concept({ conceptId: "s2", conceptName: "Strong two", estimate: 0.85 }),
    concept({ conceptId: "s3", conceptName: "Strong three", estimate: 0.8 }),
    concept({ conceptId: "s4", conceptName: "Strong four", estimate: 0.7 }),
    concept({ conceptId: "s5", conceptName: "Strong five", estimate: 0.65 }),
  ];

  it("names some and counts the rest, on both sides", () => {
    const result = buildReport(input({ concepts: many }));
    if (!result.ok) throw new Error(result.message);
    const { payload } = result;

    const unnamed = unnamedCounts(payload);
    expect(payload.standing.needsWork).toBe(4);
    expect(payload.attention.length + unnamed.attentionUnnamed).toBe(4);
    expect(unnamed.attentionUnnamed).toBeGreaterThan(0);
    expect(payload.strengths.length + unnamed.strengthsUnnamed).toBe(5);
    expect(unnamed.strengthsUnnamed).toBeGreaterThan(0);
  });

  it("says nothing when every concept is named", () => {
    const result = buildReport(input());
    if (!result.ok) throw new Error(result.message);
    expect(unnamedCounts(result.payload)).toEqual({
      attentionUnnamed: 0,
      strengthsUnnamed: 0,
    });
  });
});
