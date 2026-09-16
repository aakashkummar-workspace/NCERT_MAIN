import { describe, expect, it } from "vitest";
import {
  cohortRows,
  cohortSpread,
  conceptSpread,
  improvementFromStamps,
  insightsFrom,
  INTERVENTION_STALE_DAYS,
  MIN_COMPARABLE_CLASSES,
  MIN_MEASURED,
  MIN_MEASURED_OUTCOMES,
  STUDENT_THRESHOLD,
  type CohortInput,
  type ConceptClassInput,
  type OutcomeStamp,
} from "@/core/institute/analytics";

const DAY = 86_400_000;
const NOW = new Date("2026-09-10T09:00:00Z");

/** One student, one concept, one estimate. */
const reading = (studentUserId: string, estimate: number) => ({
  studentUserId,
  estimate,
});

function cohort(overrides: Partial<CohortInput> = {}): CohortInput {
  return {
    classId: "class-a",
    className: "10-A",
    subjectName: "Mathematics",
    academicYear: "2026-27",
    studentIds: [],
    readings: [],
    ...overrides,
  };
}

function conceptCell(overrides: Partial<ConceptClassInput> = {}): ConceptClassInput {
  return {
    conceptId: "ratio",
    conceptName: "Ratio and proportion",
    classId: "class-a",
    className: "10-A",
    estimates: [],
    enrolled: 30,
    ...overrides,
  };
}

function stamp(overrides: Partial<OutcomeStamp> = {}): OutcomeStamp {
  return {
    interventionId: "i-1",
    conceptId: "ratio",
    conceptName: "Ratio and proportion",
    classId: "class-a",
    className: "10-A",
    kind: "LESSON_PLAN",
    status: "MEASURED",
    baselineMastery: 0.4,
    baselineStudentCount: 8,
    targetMastery: 0.65,
    outcomeMastery: 0.6,
    outcomeStudentCount: 9,
    createdAt: new Date(NOW.getTime() - 30 * DAY),
    measuredAt: new Date(NOW.getTime() - 2 * DAY),
    ...overrides,
  };
}

describe("a cohort mean averages per student, then across students", () => {
  it("gives one keen student one vote, not thirty", () => {
    // The bug this exists to prevent: a flat mean over mastery rows lets a
    // student with thirty measured concepts count ten times as much as one with
    // three, so the cohort figure moves when they sit another paper and nobody
    // else does anything.
    const keen = Array.from({ length: 30 }, () => reading("keen", 0.9));
    const rest = [reading("b", 0.3), reading("c", 0.3), reading("d", 0.3)];

    const [row] = cohortRows([
      cohort({ studentIds: ["keen", "b", "c", "d"], readings: [...keen, ...rest] }),
    ]);

    // Per student: (0.9 + 0.3 + 0.3 + 0.3) / 4.
    expect(row!.meanEstimate).toBeCloseTo(0.45, 3);
    // A flat mean over the 33 rows would have been about 0.85 — a cohort in
    // trouble reported as a cohort doing well.
    expect(row!.meanEstimate!).toBeLessThan(0.6);
    expect(row!.measured).toBe(4);
  });

  it("refuses a mean below the measured threshold, and says so with both numbers", () => {
    const [row] = cohortRows([
      cohort({
        studentIds: Array.from({ length: 30 }, (_, i) => `s${i}`),
        readings: [reading("s0", 0.9), reading("s1", 0.9)],
      }),
    ]);

    expect(MIN_MEASURED).toBe(3);
    expect(row!.meanEstimate).toBeNull();
    expect(row!.band).toBeNull();
    // Withheld with the mean. "2 struggling" over 2 measured of 30 is not a
    // fact about a cohort, and printing it would smuggle the refused number
    // back onto the page.
    expect(row!.struggling).toBeNull();
    expect(row!.comparable).toBe(false);
    expect(row!.sentence).toContain("2 of 30");
  });

  it("never prints a percentage without its denominator", () => {
    const rows = cohortRows([
      cohort({
        studentIds: ["a", "b", "c", "d"],
        readings: [
          reading("a", 0.8),
          reading("b", 0.7),
          reading("c", 0.75),
          reading("d", 0.6),
        ],
      }),
      cohort({ classId: "class-b", className: "10-B", studentIds: ["e"], readings: [] }),
    ]);

    for (const row of rows) {
      if (row.sentence.includes("%")) {
        expect(row.sentence).toMatch(/of \d+ students/);
      }
    }
  });

  it("ignores estimates from somebody who is not on this roster", () => {
    const [row] = cohortRows([
      cohort({
        studentIds: ["a"],
        readings: [reading("a", 0.5), reading("a-stranger", 0.9)],
      }),
    ]);
    expect(row!.measured).toBe(1);
  });

  it("orders by who needs somebody, with the unknown cohort above the fine one", () => {
    const weak = cohort({
      classId: "weak",
      className: "10-C",
      studentIds: ["a", "b", "c"],
      readings: [reading("a", 0.3), reading("b", 0.35), reading("c", 0.4)],
    });
    const unknown = cohort({
      classId: "unknown",
      className: "10-D",
      studentIds: ["d", "e", "f", "g"],
      readings: [reading("d", 0.9)],
    });
    const fine = cohort({
      classId: "fine",
      className: "10-A",
      studentIds: ["h", "i", "j"],
      readings: [reading("h", 0.9), reading("i", 0.85), reading("j", 0.88)],
    });

    const rows = cohortRows([fine, unknown, weak]);
    // "We know nothing about these four students" is more actionable than
    // "these three are doing well" — the same rule the students index uses.
    expect(rows.map((row) => row.classId)).toEqual(["weak", "unknown", "fine"]);
  });
});

describe("the spread between cohorts", () => {
  const comparable = (id: string, name: string, value: number) =>
    cohort({
      classId: id,
      className: name,
      studentIds: ["a", "b", "c"].map((s) => `${id}-${s}`),
      readings: ["a", "b", "c"].map((s) => reading(`${id}-${s}`, value)),
    });

  it("refuses when only one cohort can be compared", () => {
    const rows = cohortRows([
      comparable("a", "10-A", 0.8),
      cohort({ classId: "b", className: "10-B", studentIds: ["x"], readings: [] }),
    ]);
    const spread = cohortSpread(rows);

    expect(MIN_COMPARABLE_CLASSES).toBe(2);
    expect(spread.gapPoints).toBeNull();
    expect(spread.comparable).toBe(1);
    expect(spread.total).toBe(2);
    expect(spread.sentence).toContain("1 of 2");
  });

  it("names both cohorts and carries both denominators", () => {
    const rows = cohortRows([
      comparable("a", "10-A", 0.8),
      comparable("b", "10-B", 0.5),
    ]);
    const spread = cohortSpread(rows);

    expect(spread.gapPoints).toBe(30);
    expect(spread.weakest!.className).toBe("10-B");
    expect(spread.strongest!.className).toBe("10-A");
    // A spread an owner cannot locate is an assertion, not a comparison.
    expect(spread.sentence).toContain("10-A");
    expect(spread.sentence).toContain("10-B");
    expect(spread.sentence).toMatch(/of \d+ students measured/);
  });
});

describe("a concept weak in more than one class", () => {
  const cell = (classId: string, className: string, values: number[]) =>
    conceptCell({ classId, className, estimates: values, enrolled: 30 });

  it("calls it systemic, and says to look at the material rather than one room", () => {
    const [row] = conceptSpread([
      cell("a", "10-A", [0.3, 0.35, 0.4]),
      cell("b", "10-B", [0.45, 0.5, 0.4]),
      cell("c", "10-C", [0.8, 0.85, 0.9]),
    ]);

    expect(row!.verdict).toBe("systemic");
    expect(row!.weakClasses).toBe(2);
    expect(row!.comparable).toBe(3);
    expect(row!.sentence).toContain("2 of the 3 classes");
    // The action is the point of the finding, not a restatement of it.
    expect(row!.action).toMatch(/more than one room/i);
    expect(row!.href).toContain("/gaps");
  });

  it("calls it that room when one class alone is behind", () => {
    const [row] = conceptSpread([
      cell("a", "10-A", [0.3, 0.35, 0.4]),
      cell("b", "10-B", [0.8, 0.85, 0.9]),
      cell("c", "10-C", [0.8, 0.85, 0.9]),
    ]);

    expect(row!.verdict).toBe("localised");
    expect(row!.sentence).toContain("10-A");
    expect(row!.action).toMatch(/that room/i);
  });

  it("counts a class below the threshold as neither weak nor fine", () => {
    const [row] = conceptSpread([
      cell("a", "10-A", [0.2, 0.25, 0.3]),
      cell("b", "10-B", [0.8, 0.85, 0.9]),
      // Two very weak students. Counting them would make this systemic, which
      // is the most confident wrong finding this page could produce.
      cell("c", "10-C", [0.1, 0.15]),
    ]);

    expect(row!.verdict).toBe("localised");
    expect(row!.weakClasses).toBe(1);
    expect(row!.comparable).toBe(2);
    const unknown = row!.classes.find((each) => each.classId === "c")!;
    expect(unknown.meanEstimate).toBeNull();
    expect(unknown.weak).toBe(false);
    // The denominator survives the refusal.
    expect(unknown.measured).toBe(2);
    expect(unknown.enrolled).toBe(30);
  });

  it("refuses a verdict at all when only one class has evidence", () => {
    const [row] = conceptSpread([
      cell("a", "10-A", [0.2, 0.25, 0.3]),
      cell("b", "10-B", [0.1]),
    ]);

    expect(row!.verdict).toBe("not-comparable");
    // One class is not a comparison, so there is no cross-class figure either.
    expect(row!.meanAcrossClasses).toBeNull();
    expect(row!.action).toMatch(/other classes/i);
  });

  it("gives each class one vote across classes, not each student", () => {
    const [row] = conceptSpread([
      conceptCell({
        classId: "big",
        className: "10-A",
        estimates: Array.from({ length: 20 }, () => 0.8),
        enrolled: 20,
      }),
      conceptCell({
        classId: "small",
        className: "10-B",
        estimates: [0.4, 0.4, 0.4, 0.4],
        enrolled: 4,
      }),
    ]);

    // The question is about rooms, so a class of twenty does not drown a class
    // of four. Weighted by student this would have been 0.73.
    expect(row!.meanAcrossClasses).toBeCloseTo(0.6, 3);
  });

  it("puts what only an owner can act on first", () => {
    const rows = conceptSpread([
      conceptCell({ conceptId: "one-room", conceptName: "Areas", classId: "a", className: "10-A", estimates: [0.3, 0.3, 0.3] }),
      conceptCell({ conceptId: "one-room", conceptName: "Areas", classId: "b", className: "10-B", estimates: [0.9, 0.9, 0.9] }),
      conceptCell({ conceptId: "everywhere", conceptName: "Ratio", classId: "a", className: "10-A", estimates: [0.3, 0.3, 0.3] }),
      conceptCell({ conceptId: "everywhere", conceptName: "Ratio", classId: "b", className: "10-B", estimates: [0.4, 0.4, 0.4] }),
    ]);

    expect(rows.map((row) => row.conceptId)).toEqual(["everywhere", "one-room"]);
  });

  it("does not call a class weak at exactly the threshold", () => {
    const [row] = conceptSpread([
      cell("a", "10-A", [STUDENT_THRESHOLD, STUDENT_THRESHOLD, STUDENT_THRESHOLD]),
      cell("b", "10-B", [0.9, 0.9, 0.9]),
    ]);
    expect(row!.weakClasses).toBe(0);
    expect(row!.verdict).toBe("steady");
  });
});

describe("improvement is only claimed against a stamped baseline", () => {
  it("refuses when nothing has been tried", () => {
    const result = improvementFromStamps([], NOW);
    expect(result.claim.claimed).toBe(false);
    if (!result.claim.claimed) expect(result.claim.reason).toBe("nothing-planned");
    // And it does not reach for a substitute baseline.
    expect(result.claim.sentence).toMatch(/stamped before the teaching/i);
  });

  it("refuses when things are running and none has been measured", () => {
    const result = improvementFromStamps(
      [
        stamp({ status: "ACTIVE", outcomeMastery: null, outcomeStudentCount: null, measuredAt: null }),
        stamp({ interventionId: "i-2", status: "ACTIVE", outcomeMastery: null, outcomeStudentCount: null, measuredAt: null }),
      ],
      NOW,
    );

    expect(result.claim.claimed).toBe(false);
    if (!result.claim.claimed) expect(result.claim.reason).toBe("nothing-measured");
    expect(result.measured).toHaveLength(0);
  });

  it("raises an old unmeasured intervention, and leaves a fresh one alone", () => {
    const result = improvementFromStamps(
      [
        stamp({
          interventionId: "old",
          status: "ACTIVE",
          outcomeMastery: null,
          outcomeStudentCount: null,
          measuredAt: null,
          createdAt: new Date(NOW.getTime() - (INTERVENTION_STALE_DAYS + 9) * DAY),
        }),
        stamp({
          interventionId: "fresh",
          status: "ACTIVE",
          outcomeMastery: null,
          outcomeStudentCount: null,
          measuredAt: null,
          createdAt: new Date(NOW.getTime() - 2 * DAY),
        }),
      ],
      NOW,
    );

    expect(result.unmeasured.map((row) => row.interventionId)).toEqual(["old"]);
    expect(result.unmeasured[0]!.days).toBe(INTERVENTION_STALE_DAYS + 9);
  });

  it("reports a measured failure exactly as it found it", () => {
    const result = improvementFromStamps(
      [stamp({ baselineMastery: 0.5, outcomeMastery: 0.42, targetMastery: 0.65 })],
      NOW,
    );

    const row = result.measured[0]!;
    // A measured failure is worth more than an unmeasured success, so nothing
    // here rounds it towards zero or hides it.
    expect(row.change).toBeCloseTo(-0.08, 3);
    expect(row.reachedTarget).toBe(false);
    expect(row.sentence).toContain("50%");
    expect(row.sentence).toContain("42%");
    // Both denominators travel with the claim.
    expect(row.sentence).toMatch(/8 students then and 9 at the measurement/);
  });

  it("measures against the stamp, not against whatever is current", () => {
    // The invariant the interventions table exists for: the same outcome
    // measured against a baseline stamped low and one stamped high are
    // different results, and only the stamp decides.
    const low = improvementFromStamps([stamp({ baselineMastery: 0.3, outcomeMastery: 0.6 })], NOW);
    const high = improvementFromStamps([stamp({ baselineMastery: 0.55, outcomeMastery: 0.6 })], NOW);

    expect(low.measured[0]!.change).toBeCloseTo(0.3, 3);
    expect(high.measured[0]!.change).toBeCloseTo(0.05, 3);
  });

  it("will not call one or two measurements an institute-wide trend", () => {
    const result = improvementFromStamps(
      [stamp(), stamp({ interventionId: "i-2" })],
      NOW,
    );

    expect(MIN_MEASURED_OUTCOMES).toBe(3);
    expect(result.claim.claimed).toBe(false);
    if (!result.claim.claimed) expect(result.claim.reason).toBe("too-few-measured");
    // Each is still a real result about the class it was aimed at.
    expect(result.measured).toHaveLength(2);
    expect(result.claim.sentence).toContain("2 of 2");
  });

  it("makes the claim once there are enough, with its denominator", () => {
    const result = improvementFromStamps(
      [
        stamp({ interventionId: "a", baselineMastery: 0.4, outcomeMastery: 0.7, targetMastery: 0.65 }),
        stamp({ interventionId: "b", baselineMastery: 0.4, outcomeMastery: 0.5, targetMastery: 0.65 }),
        stamp({ interventionId: "c", baselineMastery: 0.4, outcomeMastery: 0.6, targetMastery: 0.65 }),
      ],
      NOW,
    );

    expect(result.claim.claimed).toBe(true);
    if (result.claim.claimed) {
      expect(result.claim.count).toBe(3);
      expect(result.claim.reached).toBe(1);
      expect(result.claim.meanChange).toBeCloseTo(0.2, 3);
      expect(result.claim.sentence).toContain("3 measured interventions");
      expect(result.claim.sentence).toContain("1 of 3");
    }
    // Worst first: the one that moved least leads.
    expect(result.measured[0]!.interventionId).toBe("b");
  });
});

describe("the insights an owner reads first", () => {
  const systemic = [
    conceptCell({ conceptId: "ratio", conceptName: "Ratio", classId: "a", className: "10-A", estimates: [0.3, 0.3, 0.3] }),
    conceptCell({ conceptId: "ratio", conceptName: "Ratio", classId: "b", className: "10-B", estimates: [0.4, 0.4, 0.4] }),
  ];

  it("leads with the concept weak in more than one room", () => {
    const concepts = conceptSpread(systemic);
    const found = insightsFrom({
      cohorts: cohortRows([cohort({ studentIds: ["a"], readings: [] })]),
      concepts,
      improvement: improvementFromStamps([], NOW),
    });

    expect(found[0]!.kind).toBe("concept-systemic");
    expect(found[0]!.severity).toBe("high");
    // An owner reads the top of the list and stops.
    const severities = found.map((row) => row.severity);
    expect(severities).toEqual([...severities].sort());
  });

  it("turns a refused cohort figure into something to do", () => {
    const cohorts = cohortRows([
      cohort({
        classId: "quiet",
        className: "10-D",
        studentIds: Array.from({ length: 30 }, (_, i) => `s${i}`),
        readings: [reading("s0", 0.9)],
      }),
    ]);
    const found = insightsFrom({
      cohorts,
      concepts: [],
      improvement: improvementFromStamps([], NOW),
    });

    const row = found.find((each) => each.kind === "cohort-unmeasurable")!;
    expect(row).toBeDefined();
    expect(row.message).toContain("1 of 30");
    // Not "they are behind" — "we cannot tell", which is a different thing and
    // has a different fix.
    expect(row.message).toMatch(/not enough marked work|either way/i);
    expect(row.action).toMatch(/paper/i);
  });

  it("says an intervention that missed did not work, and does not bury it", () => {
    const found = insightsFrom({
      cohorts: [],
      concepts: [],
      improvement: improvementFromStamps(
        [stamp({ baselineMastery: 0.5, outcomeMastery: 0.45, targetMastery: 0.65 })],
        NOW,
      ),
    });

    const row = found.find((each) => each.kind === "intervention-missed")!;
    expect(row.severity).toBe("high");
    expect(row.action).toMatch(/PERSISTING/);
  });

  it("gives every insight something to do and somewhere to do it", () => {
    const found = insightsFrom({
      cohorts: cohortRows([
        cohort({
          classId: "quiet",
          className: "10-D",
          studentIds: ["a", "b", "c", "d"],
          readings: [reading("a", 0.2)],
        }),
      ]),
      concepts: conceptSpread(systemic),
      improvement: improvementFromStamps(
        [
          stamp({
            status: "ACTIVE",
            outcomeMastery: null,
            outcomeStudentCount: null,
            measuredAt: null,
            createdAt: new Date(NOW.getTime() - 40 * DAY),
          }),
        ],
        NOW,
      ),
    });

    expect(found.length).toBeGreaterThan(2);
    for (const row of found) {
      // An insight that cannot be acted on gets ignored, and then so do the
      // others.
      expect(row.action.length).toBeGreaterThan(20);
      expect(row.href.startsWith("/")).toBe(true);
      expect(row.subject.length).toBeGreaterThan(0);
      if (row.message.includes("%")) expect(row.message).toMatch(/\bof\b/);
    }
  });

  it("carries nothing that could rank a teacher", () => {
    const found = insightsFrom({
      cohorts: cohortRows([
        cohort({
          studentIds: ["a", "b", "c"],
          readings: [reading("a", 0.3), reading("b", 0.3), reading("c", 0.3)],
        }),
      ]),
      concepts: conceptSpread(systemic),
      improvement: improvementFromStamps([stamp()], NOW),
    });

    // A cohort difference is a fact about students. It becomes a claim about a
    // person only if somebody joins it to the timetable, and there is nothing
    // here to join it with.
    const serialised = JSON.stringify(found);
    expect(serialised).not.toMatch(/teacherUserId|teacherId|fullName|rank|league/i);
  });
});
