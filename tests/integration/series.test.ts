import { afterAll, describe, expect, it } from "vitest";
import {
  addPaper,
  createSeries,
  getSeries,
  listSeries,
  papersAvailable,
  removePaper,
  renameSeries,
  withdrawSeries,
} from "@/core/series";
import { canStart } from "@/core/assignments/window";
import { createAssessment, publishAssessment, setQuestions } from "@/core/assessments";
import { createAssignment, getAssignment } from "@/core/assignments";
import { generateReport } from "@/core/reports";
import { prisma } from "@/db/client";
import { platformPrisma } from "@/db/platform";
import { withTenant } from "@/db/tenant";
import { makeWorld, teacherOf, type World } from "./support/world";
import { grantReports, measuredWorld } from "./support/measured-world";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Exam series.
 *
 * The claims worth a database: three window states in one series are each
 * reported from the papers' own stamps with nothing stored; withdrawing the
 * label does not cancel the exams; a paper cannot be in two series; and a
 * report lists the papers under the name the series had when it was written,
 * with no total anywhere.
 */

const hours = (n: number) => n * 3_600_000;

/** Another paper for the world's class, with a window of our choosing. */
async function paperFor(
  world: World,
  window: { opensAt: Date; closesAt: Date },
  title = `Series paper ${Math.random().toString(36).slice(2, 8)}`,
) {
  const subject = await platformPrisma.subject.findFirstOrThrow({
    where: { id: world.subjectId },
    select: { gradeId: true },
  });
  // The paper's total has to equal what its questions are worth, or publishing
  // refuses — correctly, because a paper that cannot award full marks is a
  // paper somebody discovers at the twentieth script. Read rather than
  // assumed: the world's two questions are not one mark each.
  const marks = await withTenant(world.organizationId, (tx) =>
    tx.question.findMany({
      where: { id: { in: world.questionIds } },
      select: { marks: true },
    }),
  );
  const assessment = await createAssessment(teacherOf(world), {
    title,
    subjectId: world.subjectId,
    gradeId: subject.gradeId,
    durationMinutes: 30,
    totalMarks: marks.reduce((sum, row) => sum + row.marks, 0),
  });
  if ("error" in assessment) throw new Error(assessment.error);
  await setQuestions(teacherOf(world), assessment.id, world.questionIds);
  const published = await publishAssessment(teacherOf(world), assessment.id);
  if (!published.ok) throw new Error(`publish: ${published.problems.join(" | ")}`);

  const shut = window.closesAt.getTime() <= Date.now();
  const assigned = await createAssignment(teacherOf(world), {
    assessmentId: assessment.id,
    classId: world.classId,
    opensAt: shut ? new Date(Date.now() - 60_000) : window.opensAt,
    closesAt: shut ? new Date(Date.now() + 3_600_000) : window.closesAt,
    maxAttempts: 1,
    resultsPolicy: "AFTER_CLOSE",
  });
  if (!assigned.ok) throw new Error(`createAssignment: ${JSON.stringify(assigned)}`);

  // `createAssignment` refuses a window that has already shut — correctly:
  // handing a class a paper nobody could sit is the failure that check exists
  // for. So a paper that needs a shut window gets its stamps moved
  // afterwards, the way every other suite does it. There is no status column
  // to flip, which is the whole point.
  if (window.closesAt.getTime() <= Date.now()) {
    await withTenant(world.organizationId, (tx) =>
      tx.assignment.update({
        where: { id: assigned.id },
        data: { opensAt: window.opensAt, closesAt: window.closesAt },
      }),
    );
  }
  return assigned.id;
}

async function named(world: World, name = "Half-Yearly") {
  const created = await createSeries(teacherOf(world), {
    name,
    academicYear: "2026-27",
    note: "All Class 10 subjects.",
  });
  if (!created.ok) throw new Error(created.message);
  return created.id;
}

describe("naming one", () => {
  it("refuses a second series with the same name in the same year", async () => {
    const world = await makeWorld();
    await named(world, "Pre-Boards");

    // Two series with one name are indistinguishable on every screen that
    // lists them, and whichever a paper lands in is a coin toss.
    // Case, spacing and the separator all ignored: a school that wrote
    // "Pre Boards" on Tuesday is not naming a second event.
    const again = await createSeries(teacherOf(world), {
      name: "  pre boards  ",
      academicYear: "2026-27",
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("duplicate");
    expect(again.message).toMatch(/Pre-Boards/);  // the name the school already uses

    // The same name NEXT year is a different event, and schools reuse them.
    const nextYear = await createSeries(teacherOf(world), {
      name: "Pre-Boards",
      academicYear: "2027-28",
    });
    expect(nextYear.ok).toBe(true);
  });

  it("refuses an academic year that is not one", async () => {
    const world = await makeWorld();
    const result = await createSeries(teacherOf(world), {
      name: "Half-Yearly",
      academicYear: "2026",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/2026-27/);
  });

  it("leaves an audit row", async () => {
    const world = await makeWorld();
    const id = await named(world);
    const audits = await withTenant(world.organizationId, (tx) =>
      tx.auditLog.findMany({ where: { action: "series.created" } }),
    );
    expect(audits.map((row) => row.entityId)).toContain(id);
  });
});

describe("what it is doing is derived, never stored", () => {
  it("reports three window states from one series, with no status column", async () => {
    const world = await makeWorld();
    const id = await named(world);

    const shut = await paperFor(world, {
      opensAt: new Date(Date.now() - hours(48)),
      closesAt: new Date(Date.now() - hours(24)),
    });
    const open = await paperFor(world, {
      opensAt: new Date(Date.now() - hours(1)),
      closesAt: new Date(Date.now() + hours(1)),
    });
    const later = await paperFor(world, {
      opensAt: new Date(Date.now() + hours(24)),
      closesAt: new Date(Date.now() + hours(48)),
    });
    for (const paper of [shut, open, later]) {
      expect((await addPaper(teacherOf(world), id, paper)).ok).toBe(true);
    }

    const detail = await getSeries(world.organizationId, id);
    const byId = new Map(detail!.list.map((paper) => [paper.assignmentId, paper.status]));
    expect(byId.get(shut)).toBe("CLOSED");
    expect(byId.get(open)).toBe("OPEN");
    expect(byId.get(later)).toBe("SCHEDULED");
    // A paper open now, and one still to come: under way.
    expect(detail!.status).toBe("RUNNING");

    // The whole claim: nothing about any of that is written down. The stored
    // row holds a name, a year and a note — no status, no schedule, no total.
    const row = await withTenant(world.organizationId, (tx) =>
      tx.examSeries.findFirstOrThrow({ where: { id } }),
    );
    const stored = JSON.stringify(row).toLowerCase();
    for (const forbidden of ["status", "opensat", "closesat", "total", "percentage"]) {
      expect(stored).not.toContain(forbidden);
    }
  });

  it("takes its dates from the papers rather than from a schedule of its own", async () => {
    const world = await makeWorld();
    const id = await named(world);
    const from = new Date(Date.now() + hours(24));
    const to = new Date(Date.now() + hours(72));
    await addPaper(
      teacherOf(world),
      id,
      await paperFor(world, { opensAt: from, closesAt: new Date(Date.now() + hours(30)) }),
    );
    await addPaper(
      teacherOf(world),
      id,
      await paperFor(world, { opensAt: new Date(Date.now() + hours(48)), closesAt: to }),
    );

    const [row] = await listSeries(world.organizationId);
    expect(row!.from?.getTime()).toBe(from.getTime());
    expect(row!.to?.getTime()).toBe(to.getTime());
    expect(row!.status).toBe("UPCOMING");
  });

  it("holds nothing at first, and says so rather than erroring", async () => {
    const world = await makeWorld();
    const id = await named(world);
    const detail = await getSeries(world.organizationId, id);
    expect(detail!.status).toBe("EMPTY");
    expect(detail!.list).toEqual([]);
    expect(detail!.from).toBeNull();
  });
});

describe("a paper is in at most one series", () => {
  it("refuses to move one silently", async () => {
    const world = await makeWorld();
    const first = await named(world, "Half-Yearly");
    const second = await named(world, "Pre-Boards");
    const paper = await paperFor(world, {
      opensAt: new Date(Date.now() + hours(1)),
      closesAt: new Date(Date.now() + hours(2)),
    });

    expect((await addPaper(teacherOf(world), first, paper)).ok).toBe(true);
    const moved = await addPaper(teacherOf(world), second, paper);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    // A paper that quietly left the half-yearly when somebody built the
    // pre-boards is a paper missing from a report nobody will re-read.
    expect(moved.reason).toBe("taken");

    // Adding it to the series it is already in is not an error.
    expect((await addPaper(teacherOf(world), first, paper)).ok).toBe(true);
  });

  it("offers only papers in no series, and offers finished ones too", async () => {
    const world = await makeWorld();
    const id = await named(world);
    const shut = await paperFor(world, {
      opensAt: new Date(Date.now() - hours(48)),
      closesAt: new Date(Date.now() - hours(24)),
    });

    // A school routinely names the event after the week it happened in, so a
    // picker that hid shut papers would make that impossible.
    let available = await papersAvailable(world.organizationId);
    expect(available.map((paper) => paper.assignmentId)).toContain(shut);

    await addPaper(teacherOf(world), id, shut);
    available = await papersAvailable(world.organizationId);
    expect(available.map((paper) => paper.assignmentId)).not.toContain(shut);
  });

  it("takes a paper out without touching the paper", async () => {
    const world = await makeWorld();
    const id = await named(world);
    const opensAt = new Date(Date.now() - hours(1));
    const closesAt = new Date(Date.now() + hours(1));
    const paper = await paperFor(world, { opensAt, closesAt });
    await addPaper(teacherOf(world), id, paper);

    expect((await removePaper(teacherOf(world), id, paper)).ok).toBe(true);

    const after = await getAssignment(world.organizationId, paper);
    expect(after!.series).toBeNull();
    expect(after!.cancelledAt).toBeNull();
    expect(after!.opensAt.getTime()).toBe(opensAt.getTime());
    expect(after!.closesAt.getTime()).toBe(closesAt.getTime());
    expect(canStart(after!)).toBe(true);

    // And taking it out twice is not a second removal.
    expect((await removePaper(teacherOf(world), id, paper)).ok).toBe(false);
  });
});

describe("withdrawing the label does not cancel the exams", () => {
  it("leaves every paper open and sittable", async () => {
    const world = await makeWorld();
    const id = await named(world);
    const paper = await paperFor(world, {
      opensAt: new Date(Date.now() - hours(1)),
      closesAt: new Date(Date.now() + hours(1)),
    });
    await addPaper(teacherOf(world), id, paper);

    const result = await withdrawSeries(teacherOf(world), id);
    expect(result).toEqual({ ok: true, papers: 1 });

    // The one thing this must never do. A teacher tidying up a label they
    // mistyped must not silently cancel six exams a class is about to sit.
    const after = await getAssignment(world.organizationId, paper);
    expect(after!.cancelledAt).toBeNull();
    expect(after!.status).toBe("OPEN");
    expect(canStart(after!)).toBe(true);

    // A stamp, not a delete: the row survives and says it was withdrawn.
    const detail = await getSeries(world.organizationId, id);
    expect(detail!.withdrawn).toBe(true);
    expect(detail!.status).toBe("WITHDRAWN");
    // And it is out of the list a teacher works from.
    expect((await listSeries(world.organizationId)).map((row) => row.id)).not.toContain(id);
    expect(
      (await listSeries(world.organizationId, { includeWithdrawn: true })).map(
        (row) => row.id,
      ),
    ).toContain(id);

    expect(await withdrawSeries(teacherOf(world), id)).toEqual({ ok: false, papers: 0 });
  });
});

describe("the report lists them under the name", () => {
  it("stamps the series on each paper, and a rename does not follow", async () => {
    const { world, assignmentId } = await measuredWorld();
    const id = await named(world, "Half-Yearly");
    expect((await addPaper(teacherOf(world), id, assignmentId)).ok).toBe(true);

    const report = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      periodStart: new Date("2026-04-01T00:00:00Z"),
      periodEnd: new Date(Date.now() + hours(1)),
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const sittings = report.payload.sittings.filter(
      (sitting) => sitting.assignmentId === assignmentId,
    );
    expect(sittings.length).toBe(1);
    expect(sittings[0]!.seriesId).toBe(id);
    expect(sittings[0]!.seriesName).toBe("Half-Yearly");

    // A report is STAMPED. Renaming the series in December must not change
    // what a parent was handed in September — the same invariant as the rest
    // of this payload.
    expect((await renameSeries(teacherOf(world), id, { name: "Term 1 Exams" })).ok).toBe(
      true,
    );
    const stored = await withTenant(world.organizationId, (tx) =>
      tx.report.findFirstOrThrow({ where: { id: report.reportId } }),
    );
    expect(JSON.stringify(stored.payload)).toContain("Half-Yearly");
    expect(JSON.stringify(stored.payload)).not.toContain("Term 1 Exams");
  });

  it("carries no aggregate across the series", async () => {
    const { world, assignmentId } = await measuredWorld();
    const id = await named(world);
    await addPaper(teacherOf(world), id, assignmentId);

    const report = await generateReport(teacherOf(world), {
      studentUserId: world.studentId,
      periodStart: new Date("2026-04-01T00:00:00Z"),
      periodEnd: new Date(Date.now() + hours(1)),
    });
    if (!report.ok) throw new Error("expected a report");

    // The composite this product refuses everywhere else, on the one document
    // a family keeps. The payload holds per-paper marks and nothing above
    // them: there is no series object at all, so nothing can carry a total.
    expect(Object.keys(report.payload)).not.toContain("series");
    for (const sitting of report.payload.sittings) {
      expect(Object.keys(sitting)).not.toContain("seriesPercentage");
      expect(Object.keys(sitting)).not.toContain("seriesTotal");
    }
  });
});

describe("tenancy", () => {
  it("shows one organization nothing of another's series", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    const id = await named(world);
    const paper = await paperFor(world, {
      opensAt: new Date(Date.now() + hours(1)),
      closesAt: new Date(Date.now() + hours(2)),
    });
    await addPaper(teacherOf(world), id, paper);

    expect(await getSeries(other.organizationId, id)).toBeNull();
    expect((await listSeries(other.organizationId)).map((row) => row.id)).not.toContain(id);
    expect(await withdrawSeries(teacherOf(other), id)).toEqual({ ok: false, papers: 0 });
    expect((await renameSeries(teacherOf(other), id, { name: "Theirs" })).ok).toBe(false);
    expect((await addPaper(teacherOf(other), id, paper)).ok).toBe(false);
    expect((await removePaper(teacherOf(other), id, paper)).ok).toBe(false);

    // And the paper is still in the series it was in.
    const detail = await getSeries(world.organizationId, id);
    expect(detail!.list.map((row) => row.assignmentId)).toEqual([paper]);
  });

  it("cannot put another organization's paper in its own series", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    await grantReports(other.organizationId);
    const mine = await named(other, "Mine");
    const theirs = await paperFor(world, {
      opensAt: new Date(Date.now() + hours(1)),
      closesAt: new Date(Date.now() + hours(2)),
    });

    const result = await addPaper(teacherOf(other), mine, theirs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not "taken" — as far as this tenant is concerned the paper does not
    // exist, which is the answer RLS gives and the answer it should give.
    expect(result.reason).toBe("not-found");
  });
});
