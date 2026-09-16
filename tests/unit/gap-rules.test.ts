import { describe, expect, it } from "vitest";
import {
  classVerdict,
  isStudentGap,
  rootCause,
  studentSeverity,
  interventionStateOf,
  transitionFor,
  CLASS_MINIMUM,
  MIN_MEASURED,
  STUDENT_THRESHOLD,
  type StudentReading,
} from "@/core/gaps/rules";

const measured = (estimate: number, id = "s"): StudentReading => ({
  studentUserId: id,
  estimate,
  band: estimate < 0.4 ? "CRITICAL" : estimate < 0.6 ? "FRAGILE" : "DEVELOPING",
});

const unmeasured = (id = "s"): StudentReading => ({
  studentUserId: id,
  estimate: null,
  band: "INSUFFICIENT",
});

describe("a gap is not a low score", () => {
  it("ignores a student the estimator refused to measure", () => {
    // Not counted as struggling and not counted as fine. A class that scored
    // badly on a paper nobody has finished marking is a marking backlog, not a
    // gap, and reteaching on that basis wastes a lesson.
    expect(isStudentGap(unmeasured())).toBe(false);
  });

  it("is below the DEVELOPING floor, the same boundary the colours use", () => {
    expect(isStudentGap(measured(0.59))).toBe(true);
    expect(isStudentGap(measured(STUDENT_THRESHOLD))).toBe(false);
    expect(isStudentGap(measured(0.9))).toBe(false);
  });

  it("separates cannot-at-all from can-sometimes", () => {
    // Those need different lessons, so they get different severities rather
    // than one "below threshold" bucket that flattens the difference.
    expect(studentSeverity(0.2)).toBe("HIGH");
    expect(studentSeverity(0.45)).toBe("MEDIUM");
    expect(studentSeverity(0.55)).toBe("LOW");
  });
});

describe("a class-scope gap", () => {
  it("says nothing when too few students are measured", () => {
    const verdict = classVerdict([measured(0.1, "a"), measured(0.1, "b"), unmeasured("c")]);
    expect(verdict.gap).toBe(false);
    if (verdict.gap) return;
    expect(verdict.reason).toBe("too-few-measured");
    expect(verdict.measured).toBeLessThan(MIN_MEASURED);
  });

  it("does not fire when most of the class is fine", () => {
    const verdict = classVerdict([
      measured(0.2, "a"),
      measured(0.8, "b"),
      measured(0.85, "c"),
      measured(0.9, "d"),
      measured(0.75, "e"),
      measured(0.8, "f"),
    ]);
    expect(verdict.gap).toBe(false);
    if (verdict.gap) return;
    expect(verdict.reason).toBe("enough-doing-well");
    expect(verdict.struggling).toBe(1);
  });

  it("needs a real number of students, not just a fraction", () => {
    // Two of four is 50% and still two students. Putting a lesson on the
    // timetable for them is the wrong call; a conversation is the right one.
    const verdict = classVerdict([
      measured(0.2, "a"),
      measured(0.3, "b"),
      measured(0.9, "c"),
      measured(0.9, "d"),
    ]);
    expect(verdict.gap).toBe(false);
    if (verdict.gap) return;
    expect(verdict.struggling).toBeLessThan(CLASS_MINIMUM);
  });

  it("fires when a third of the measured class is below the line", () => {
    const verdict = classVerdict([
      measured(0.3, "a"),
      measured(0.35, "b"),
      measured(0.4, "c"),
      measured(0.9, "d"),
      measured(0.85, "e"),
      measured(0.8, "f"),
    ]);
    expect(verdict.gap).toBe(true);
    if (!verdict.gap) return;
    expect(verdict.struggling).toBe(3);
    expect(verdict.measured).toBe(6);
  });

  it("averages the students who are behind, not the whole class", () => {
    // A gap's severity is about how far behind the students who are behind
    // are. Averaging in the ones who are fine makes a class with a few very
    // weak students look like a class with a mild problem.
    const verdict = classVerdict([
      measured(0.1, "a"),
      measured(0.15, "b"),
      measured(0.2, "c"),
      measured(0.95, "d"),
      measured(0.95, "e"),
      measured(0.95, "f"),
    ]);
    expect(verdict.gap).toBe(true);
    if (!verdict.gap) return;
    expect(verdict.meanEstimate).toBeCloseTo(0.15, 2);
    expect(verdict.severity).toBe("HIGH");
  });

  it("calls a whole class being lost HIGH", () => {
    const verdict = classVerdict([
      measured(0.5, "a"),
      measured(0.55, "b"),
      measured(0.5, "c"),
      measured(0.55, "d"),
    ]);
    expect(verdict.gap).toBe(true);
    if (!verdict.gap) return;
    // Everybody measured is below the line, even though none is catastrophic.
    expect(verdict.severity).toBe("HIGH");
  });

  it("does not count the unmeasured in either direction", () => {
    const withUnmeasured = classVerdict([
      measured(0.2, "a"),
      measured(0.25, "b"),
      measured(0.3, "c"),
      unmeasured("d"),
      unmeasured("e"),
      unmeasured("f"),
    ]);
    expect(withUnmeasured.gap).toBe(true);
    if (!withUnmeasured.gap) return;
    // Three of three measured, not three of six. The denominator is what the
    // product actually knows.
    expect(withUnmeasured.measured).toBe(3);
    expect(withUnmeasured.struggling).toBe(3);
  });
});

describe("the root cause", () => {
  it("names nothing when the foundations are solid", () => {
    // A prerequisite the class has already mastered is not why they are stuck,
    // and naming it sends a teacher to reteach something they can do.
    expect(rootCause([{ conceptId: "ratio", meanEstimate: 0.9 }])).toBeNull();
  });

  it("names nothing when the prerequisite is unmeasured", () => {
    expect(rootCause([{ conceptId: "ratio", meanEstimate: null }])).toBeNull();
  });

  it("names a prerequisite the class is also weak on", () => {
    expect(rootCause([{ conceptId: "ratio", meanEstimate: 0.3 }])).toBe("ratio");
  });

  it("picks the shakiest foundation when two are weak", () => {
    expect(
      rootCause([
        { conceptId: "ratio", meanEstimate: 0.5 },
        { conceptId: "fractions", meanEstimate: 0.2 },
      ]),
    ).toBe("fractions");
  });
});

describe("what happens on re-detection", () => {
  it("resolves only when the evidence says so", () => {
    expect(transitionFor("DETECTED", false)).toEqual({
      status: "RESOLVED",
      resolved: true,
    });
  });

  it("never resolves while the concept is still below threshold", () => {
    // The invariant: a gap resolves on new evidence, never on the passage of
    // time and never on somebody marking it done. A dashboard whose gaps can
    // be dismissed measures how tidy the teacher is.
    for (const previous of [null, "DETECTED", "ACKNOWLEDGED", "INTERVENING", "PERSISTING"]) {
      expect(transitionFor(previous, true).resolved).toBe(false);
    }
  });

  it("marks a gap as PERSISTING only after a measured miss", () => {
    // The most important signal in the product. It says the thing that was
    // tried did not work — which only a measurement can say.
    expect(transitionFor("INTERVENING", true, "MISSED").status).toBe("PERSISTING");
    expect(transitionFor("PERSISTING", true, "MISSED").status).toBe("PERSISTING");
    expect(transitionFor("ACKNOWLEDGED", true, "MISSED").status).toBe("PERSISTING");
  });

  it("keeps an open intervention INTERVENING however often detection runs", () => {
    // Detection runs on every submission and every saved mark. A gap used to
    // flip to "still there after an intervention" minutes after a lesson was
    // recorded, the first time anybody handed in any paper.
    expect(transitionFor("INTERVENING", true, "OPEN").status).toBe("INTERVENING");
    expect(transitionFor("INTERVENING", true).status).not.toBe("PERSISTING");
    // A new attempt on a gap that had persisted is being worked on again.
    expect(transitionFor("PERSISTING", true, "OPEN").status).toBe("INTERVENING");
  });

  it("does not call a measured success a failure", () => {
    expect(transitionFor("INTERVENING", true, "MET").status).toBe("ACKNOWLEDGED");
  });

  it("still resolves on evidence with an intervention open", () => {
    expect(transitionFor("INTERVENING", false, "OPEN")).toEqual({
      status: "RESOLVED",
      resolved: true,
    });
  });

  it("reads the latest intervention's state from its row", () => {
    expect(interventionStateOf([])).toBe("NONE");
    expect(
      interventionStateOf([{ status: "ACTIVE", outcomeMastery: null, targetMastery: 0.65 }]),
    ).toBe("OPEN");
    expect(
      interventionStateOf([{ status: "MEASURED", outcomeMastery: 0.5, targetMastery: 0.65 }]),
    ).toBe("MISSED");
    expect(
      interventionStateOf([{ status: "MEASURED", outcomeMastery: 0.7, targetMastery: 0.65 }]),
    ).toBe("MET");
    // Newest first: an old miss does not outvote the attempt now running.
    expect(
      interventionStateOf([
        { status: "ACTIVE", outcomeMastery: null, targetMastery: 0.65 },
        { status: "MEASURED", outcomeMastery: 0.4, targetMastery: 0.65 },
      ]),
    ).toBe("OPEN");
  });

  it("leaves an acknowledged gap acknowledged", () => {
    // Somebody has already seen this one. Putting it back in front of them as
    // new is how a list of findings becomes noise.
    expect(transitionFor("ACKNOWLEDGED", true).status).toBe("ACKNOWLEDGED");
  });

  it("calls a new one DETECTED", () => {
    expect(transitionFor(null, true).status).toBe("DETECTED");
  });
});
