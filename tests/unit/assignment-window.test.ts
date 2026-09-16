import { describe, expect, it } from "vitest";
import {
  assignmentStatus,
  canStart,
  describeWindow,
  suggestWindow,
  validateWindow,
} from "@/core/assignments/window";

const at = (iso: string) => new Date(iso);

const window = {
  opensAt: at("2026-09-10T04:00:00Z"),
  closesAt: at("2026-09-10T14:30:00Z"),
};

describe("assignmentStatus", () => {
  it("is SCHEDULED before the window opens", () => {
    expect(assignmentStatus(window, at("2026-09-10T03:59:59Z"))).toBe("SCHEDULED");
  });

  it("is OPEN from the instant it opens", () => {
    // Inclusive at the opening edge: a student refreshing at exactly 09:30
    // should be able to start.
    expect(assignmentStatus(window, at("2026-09-10T04:00:00Z"))).toBe("OPEN");
    expect(assignmentStatus(window, at("2026-09-10T10:00:00Z"))).toBe("OPEN");
  });

  it("is CLOSED from the instant it closes", () => {
    // Exclusive at the closing edge: nobody starts a paper they cannot finish.
    expect(assignmentStatus(window, at("2026-09-10T14:30:00Z"))).toBe("CLOSED");
    expect(assignmentStatus(window, at("2026-09-11T00:00:00Z"))).toBe("CLOSED");
  });

  it("is CANCELLED whatever the clock says", () => {
    const cancelled = { ...window, cancelledAt: at("2026-09-09T00:00:00Z") };
    expect(assignmentStatus(cancelled, at("2026-09-10T10:00:00Z"))).toBe("CANCELLED");
    expect(assignmentStatus(cancelled, at("2026-09-01T00:00:00Z"))).toBe("CANCELLED");
  });

  it("never needs a job to keep it true", () => {
    // The property the whole design rests on: the same row gives the right
    // answer at every moment, with nothing having written to it.
    const moments: [string, string][] = [
      ["2026-09-09T00:00:00Z", "SCHEDULED"],
      ["2026-09-10T04:00:00Z", "OPEN"],
      ["2026-09-10T14:29:59Z", "OPEN"],
      ["2026-09-10T14:30:00Z", "CLOSED"],
    ];
    for (const [moment, expected] of moments) {
      expect(assignmentStatus(window, at(moment)), moment).toBe(expected);
    }
  });
});

describe("canStart", () => {
  it("is true only while open", () => {
    expect(canStart(window, at("2026-09-10T10:00:00Z"))).toBe(true);
    expect(canStart(window, at("2026-09-10T03:00:00Z"))).toBe(false);
    expect(canStart(window, at("2026-09-10T15:00:00Z"))).toBe(false);
    expect(
      canStart({ ...window, cancelledAt: new Date() }, at("2026-09-10T10:00:00Z")),
    ).toBe(false);
  });
});

describe("validateWindow", () => {
  const now = at("2026-09-09T00:00:00Z");

  const valid = {
    opensAt: at("2026-09-10T04:00:00Z"),
    closesAt: at("2026-09-10T14:30:00Z"),
    durationMinutes: 45,
    maxAttempts: 1,
    now,
  };

  it("accepts a sensible window", () => {
    expect(validateWindow(valid)).toEqual([]);
  });

  it("rejects a window that closes before it opens", () => {
    const problems = validateWindow({
      ...valid,
      closesAt: at("2026-09-10T03:00:00Z"),
    });
    expect(problems[0]?.message).toMatch(/close after it opens/);
  });

  it("rejects a window shorter than the test", () => {
    // The failure that hands a class a test they cannot finish.
    const problems = validateWindow({
      ...valid,
      closesAt: at("2026-09-10T04:30:00Z"),
      durationMinutes: 45,
    });
    expect(problems.some((p) => /Nobody could finish it/.test(p.message))).toBe(true);
  });

  it("measures against the override when there is one", () => {
    const problems = validateWindow({
      ...valid,
      closesAt: at("2026-09-10T05:00:00Z"),
      durationMinutes: 45,
      durationOverrideMinutes: 90,
    });
    expect(problems.some((p) => /takes 90/.test(p.message))).toBe(true);
  });

  it("rejects a window that has already closed", () => {
    const problems = validateWindow({
      ...valid,
      opensAt: at("2026-09-01T04:00:00Z"),
      closesAt: at("2026-09-01T14:30:00Z"),
    });
    expect(problems.some((p) => /already closed/.test(p.message))).toBe(true);
  });

  it("rejects an absurd attempt count", () => {
    expect(validateWindow({ ...valid, maxAttempts: 0 })).not.toEqual([]);
    expect(validateWindow({ ...valid, maxAttempts: 9 })).not.toEqual([]);
  });

  it("rejects an absurd duration override", () => {
    expect(
      validateWindow({ ...valid, durationOverrideMinutes: 2 }),
    ).not.toEqual([]);
    expect(
      validateWindow({ ...valid, durationOverrideMinutes: 999 }),
    ).not.toEqual([]);
  });

  it("accepts extra time as an override", () => {
    // Extra time for a student who needs it is a legitimate, common case.
    expect(
      validateWindow({ ...valid, durationOverrideMinutes: 60 }),
    ).toEqual([]);
  });

  it("does not crash on an invalid date", () => {
    const problems = validateWindow({
      ...valid,
      opensAt: new Date("not a date"),
    });
    expect(problems[0]?.field).toBe("opensAt");
  });
});

describe("suggestWindow", () => {
  it("suggests a window that passes its own validation", () => {
    const now = at("2026-09-09T06:00:00Z");
    const suggested = suggestWindow(45, now);
    expect(
      validateWindow({
        ...suggested,
        durationMinutes: 45,
        maxAttempts: 1,
        now,
      }),
    ).toEqual([]);
  });

  it("leaves room for a long paper", () => {
    const now = at("2026-09-09T13:00:00Z");
    const suggested = suggestWindow(180, now);
    const minutes =
      (suggested.closesAt.getTime() - suggested.opensAt.getTime()) / 60000;
    expect(minutes).toBeGreaterThan(180);
  });
});

describe("describeWindow", () => {
  it("counts down to opening in the unit that reads best", () => {
    expect(describeWindow(window, at("2026-09-10T03:30:00Z"))).toBe(
      "Opens in 30 minutes",
    );
    expect(describeWindow(window, at("2026-09-10T00:00:00Z"))).toBe("Opens in 4 hours");
    expect(describeWindow(window, at("2026-09-08T04:00:00Z"))).toBe("Opens in 2 days");
  });

  it("counts down to closing while it is open", () => {
    // What a teacher needs during a sitting; a timestamp is not.
    expect(describeWindow(window, at("2026-09-10T14:00:00Z"))).toBe(
      "Closes in 30 minutes",
    );
    expect(describeWindow(window, at("2026-09-10T10:30:00Z"))).toBe("Closes in 4 hours");
  });

  it("says the plain thing once it is over", () => {
    expect(describeWindow(window, at("2026-09-11T00:00:00Z"))).toBe("Closed");
  });

  it("says cancelled whatever the clock says", () => {
    expect(
      describeWindow({ ...window, cancelledAt: new Date() }, at("2026-09-10T10:00:00Z")),
    ).toBe("Cancelled");
  });

  it("uses the singular when it should", () => {
    expect(describeWindow(window, at("2026-09-10T03:59:00Z"))).toBe(
      "Opens in 1 minute",
    );
  });
});
