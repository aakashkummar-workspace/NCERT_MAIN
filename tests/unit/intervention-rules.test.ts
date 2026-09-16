import { describe, expect, it } from "vitest";
import { targetFor } from "@/core/gaps/interventions";
import { calibrate, MIN_REMEDIAL_QUESTIONS } from "@/core/gaps/remedial";
import { STUDENT_THRESHOLD } from "@/core/gaps/rules";

describe("targetFor", () => {
  it("clears the threshold that made it a gap in the first place", () => {
    // The point a teacher would call it fixed. A target below the line that
    // defines a gap would let an intervention "succeed" while the gap it was
    // aimed at is still open.
    for (const baseline of [0.1, 0.25, 0.4, 0.55]) {
      expect(targetFor(baseline)).toBeGreaterThan(STUDENT_THRESHOLD);
    }
  });

  it("is always ahead of where the group already was", () => {
    for (const baseline of [0, 0.2, 0.45, 0.6, 0.8, 0.9]) {
      expect(targetFor(baseline)).toBeGreaterThan(baseline);
    }
  });

  it("asks for a real move, not a rounding error", () => {
    expect(targetFor(0.55)).toBeCloseTo(0.7, 5);
    expect(targetFor(0.7)).toBeCloseTo(0.85, 5);
  });

  it("stops short of perfect", () => {
    // 1.0 is not a teaching target; it is a promise nobody can keep, and an
    // intervention that can only ever be recorded as a failure teaches the
    // teacher to stop recording them.
    expect(targetFor(0.95)).toBeLessThanOrEqual(0.95);
    expect(targetFor(0.99)).toBeLessThanOrEqual(0.95);
  });
});

describe("calibrate", () => {
  it("gives a group that cannot do it at all nothing hard", () => {
    // A hard question here measures what is already known — that they are
    // stuck — and costs a student who is behind their confidence to learn it.
    expect(calibrate(0.2).HARD).toBe(0);
    expect(calibrate(0.39).HARD).toBe(0);
  });

  it("leans easier the further behind the group is", () => {
    expect(calibrate(0.2).EASY).toBeGreaterThan(calibrate(0.45).EASY);
    expect(calibrate(0.45).EASY).toBeGreaterThan(calibrate(0.58).EASY);
  });

  it("keeps enough medium to tell 'can now' from 'got lucky'", () => {
    for (const mean of [0.2, 0.45, 0.58]) {
      expect(calibrate(mean).MEDIUM).toBeGreaterThanOrEqual(30);
    }
  });

  it("always adds up to a whole paper", () => {
    for (const mean of [0, 0.15, 0.35, 0.4, 0.49, 0.5, 0.59]) {
      const mix = calibrate(mean);
      expect(mix.EASY + mix.MEDIUM + mix.HARD).toBe(100);
    }
  });
});

describe("the remedial floor", () => {
  it("is high enough that a second reading means something", () => {
    // One question is a coin toss. The floor exists so a teacher is told the
    // bank is too thin rather than handed a paper that cannot answer the
    // question it was built to answer.
    expect(MIN_REMEDIAL_QUESTIONS).toBeGreaterThanOrEqual(4);
  });
});
