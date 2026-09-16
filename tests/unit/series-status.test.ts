import { describe, expect, it } from "vitest";
import { seriesSpan, seriesStatus } from "@/core/series/status";
import { groupBySeries, type ReportSheetSitting } from "@/ui/ReportSheet";

/**
 * What a series is doing, and how its papers are grouped on a report.
 *
 * Both are DERIVED — from the papers' windows and the clock, and from the
 * series stamped on each sitting. Neither is stored, so neither can drift from
 * what it describes. These are the two pure pieces, so this is where that is
 * pinned.
 */

const NOW = new Date("2026-10-05T09:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const paper = (
  over: { opensAt?: Date; closesAt?: Date; cancelledAt?: Date | null } = {},
) => ({
  opensAt: over.opensAt ?? days(1),
  closesAt: over.closesAt ?? days(2),
  cancelledAt: over.cancelledAt ?? null,
});

describe("a series has no status of its own", () => {
  it("is EMPTY while it holds nothing, which is a real state", () => {
    // A named series with no papers is where every series starts. Reporting it
    // as "finished" or as an error would both be wrong.
    expect(seriesStatus({}, [], NOW)).toBe("EMPTY");
  });

  it("is UPCOMING when every paper is still to open", () => {
    expect(seriesStatus({}, [paper(), paper({ opensAt: days(3), closesAt: days(4) })], NOW)).toBe(
      "UPCOMING",
    );
  });

  it("is RUNNING when a paper is open now", () => {
    expect(
      seriesStatus({}, [paper({ opensAt: days(-1), closesAt: days(1) })], NOW),
    ).toBe("RUNNING");
  });

  it("is RUNNING mid-week, when some have shut and others have not opened", () => {
    // Most of a half-yearly week looks like this: Monday's paper is over,
    // Wednesday's has not opened, and nothing is open at this exact minute.
    // "Finished" would be false and "coming up" would be worse.
    const status = seriesStatus(
      {},
      [
        paper({ opensAt: days(-3), closesAt: days(-2) }),
        paper({ opensAt: days(2), closesAt: days(3) }),
      ],
      NOW,
    );
    expect(status).toBe("RUNNING");
  });

  it("is FINISHED only when every window has shut", () => {
    expect(
      seriesStatus(
        {},
        [
          paper({ opensAt: days(-4), closesAt: days(-3) }),
          paper({ opensAt: days(-2), closesAt: days(-1) }),
        ],
        NOW,
      ),
    ).toBe("FINISHED");
  });

  it("reports the three window states from one set of papers", () => {
    // The plan's own proof, on the pure function: scheduled, open and closed
    // papers in one series, each derived from its own stamps.
    const papers = [
      paper({ opensAt: days(-4), closesAt: days(-3) }),
      paper({ opensAt: days(-1), closesAt: days(1) }),
      paper({ opensAt: days(3), closesAt: days(4) }),
    ];
    expect(seriesStatus({}, papers, NOW)).toBe("RUNNING");
    // And it moves with the clock alone — nothing was written.
    expect(seriesStatus({}, papers, days(10))).toBe("FINISHED");
    expect(seriesStatus({}, papers, days(-10))).toBe("UPCOMING");
  });

  it("ignores a cancelled paper when deciding, and is not stalled by one", () => {
    const papers = [
      paper({ opensAt: days(-4), closesAt: days(-3) }),
      paper({ opensAt: days(3), closesAt: days(4), cancelledAt: days(-1) }),
    ];
    // The last live paper is over, so the series is over — a called-off paper
    // must not keep a half-yearly open forever.
    expect(seriesStatus({}, papers, NOW)).toBe("FINISHED");
  });

  it("is EMPTY when every paper it holds was cancelled", () => {
    expect(seriesStatus({}, [paper({ cancelledAt: days(-1) })], NOW)).toBe("EMPTY");
  });

  it("says WITHDRAWN before it says anything about the papers", () => {
    // Withdrawing the label does not touch the papers, so the papers here are
    // deliberately open: what changed is the grouping, not the exams.
    expect(
      seriesStatus(
        { cancelledAt: days(-1) },
        [paper({ opensAt: days(-1), closesAt: days(1) })],
        NOW,
      ),
    ).toBe("WITHDRAWN");
  });
});

describe("the span comes from the papers", () => {
  it("runs from the first opening to the last closing", () => {
    const span = seriesSpan([
      paper({ opensAt: days(2), closesAt: days(3) }),
      paper({ opensAt: days(-1), closesAt: days(0) }),
    ]);
    expect(span?.from).toEqual(days(-1));
    expect(span?.to).toEqual(days(3));
  });

  it("is null while the series holds nothing, rather than a made-up range", () => {
    expect(seriesSpan([])).toBeNull();
    expect(seriesSpan([paper({ cancelledAt: days(-1) })])).toBeNull();
  });
});

const sitting = (over: Partial<ReportSheetSitting> = {}): ReportSheetSitting => ({
  assignmentId: over.assignmentId ?? "a1",
  title: over.title ?? "Mathematics",
  subjectName: over.subjectName ?? "Mathematics",
  satAt: over.satAt ?? "2026-10-01T00:00:00.000Z",
  attempts: over.attempts ?? 1,
  percentage: over.percentage === undefined ? 0.6 : over.percentage,
  awarded: over.awarded === undefined ? 18 : over.awarded,
  total: over.total === undefined ? 30 : over.total,
  seriesId: over.seriesId ?? null,
  seriesName: over.seriesName ?? null,
});

describe("grouping a report's papers", () => {
  it("leaves a sheet with no series exactly as it was", () => {
    // A school that never names a series must see no change at all: one
    // unnamed group, which the sheet renders as the plain table.
    const groups = groupBySeries([sitting(), sitting({ assignmentId: "a2" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.seriesName).toBeNull();
    expect(groups[0]!.sittings).toHaveLength(2);
  });

  it("groups by series and runs them in the order they were sat", () => {
    const groups = groupBySeries([
      sitting({
        assignmentId: "a1",
        seriesId: "s2",
        seriesName: "Pre-Boards",
        satAt: "2026-12-01T00:00:00.000Z",
      }),
      sitting({
        assignmentId: "a2",
        seriesId: "s1",
        seriesName: "Half-Yearly",
        satAt: "2026-10-01T00:00:00.000Z",
      }),
      sitting({
        assignmentId: "a3",
        seriesId: "s1",
        seriesName: "Half-Yearly",
        satAt: "2026-10-03T00:00:00.000Z",
      }),
    ]);
    expect(groups.map((group) => group.seriesName)).toEqual([
      "Half-Yearly",
      "Pre-Boards",
    ]);
    expect(groups[0]!.sittings).toHaveLength(2);
  });

  it("puts papers in no series last, under their own group", () => {
    const groups = groupBySeries([
      sitting({ assignmentId: "a1" }),
      sitting({ assignmentId: "a2", seriesId: "s1", seriesName: "Half-Yearly" }),
    ]);
    expect(groups.map((group) => group.seriesId)).toEqual(["s1", null]);
  });

  it("carries no total for a group, and has no field for one", () => {
    const [group] = groupBySeries([
      sitting({ seriesId: "s1", seriesName: "Half-Yearly" }),
      sitting({ assignmentId: "a2", seriesId: "s1", seriesName: "Half-Yearly" }),
    ]);
    // The refusal is structural: there is nowhere to put an aggregate, so no
    // screen can print one. Six papers out of different totals, some part
    // marked, do not average into anything defensible — and a report card is
    // where that number would do the most harm.
    expect(Object.keys(group!).sort()).toEqual(["seriesId", "seriesName", "sittings"]);
  });

  it("groups on the id, so two series may share a name", () => {
    const groups = groupBySeries([
      sitting({ assignmentId: "a1", seriesId: "s1", seriesName: "Unit Tests" }),
      sitting({ assignmentId: "a2", seriesId: "s2", seriesName: "Unit Tests" }),
    ]);
    expect(groups).toHaveLength(2);
  });
});
