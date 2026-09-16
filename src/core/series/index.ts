import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { assignmentStatus, type AssignmentStatus } from "@/core/assignments/window";
import { seriesSpan, seriesStatus, type SeriesStatus } from "./status";

/**
 * A named series of papers — a half-yearly, a set of unit tests, pre-boards.
 *
 * ---------------------------------------------------------------------------
 * It is a LABEL, and that is the whole design
 * ---------------------------------------------------------------------------
 * A series holds no window, no marks and no status. Each paper keeps its own
 * window, its own results policy and its own marking, exactly as before; the
 * series says which papers a school considers one event. So nothing about
 * assigning, sitting, marking or releasing changes, and a school that never
 * makes one loses nothing.
 *
 * ---------------------------------------------------------------------------
 * No aggregate across the series, ever
 * ---------------------------------------------------------------------------
 * "Half-yearly: 68%" is the composite score this product refuses everywhere
 * else — no overall score per student, no class mastery score, no grade on a
 * report, no readiness percentage — arriving at the one place the pressure is
 * strongest, because a series looks exactly like a report card. Six papers
 * marked out of different totals, some part marked, some unreleased, averaged
 * into one number, is a figure nobody can defend and everybody would rank by.
 *
 * So there is no total here and no field to put one in. Per-paper marks,
 * listed, each carrying whether it is finished being marked.
 *
 * ---------------------------------------------------------------------------
 * Withdrawing a series does not cancel its papers
 * ---------------------------------------------------------------------------
 * `cancelledAt` on the series means "stop grouping these". The papers keep
 * their windows and their students. A teacher tidying up a label they mistyped
 * must not silently cancel six exams a class is about to sit — and the reverse
 * is also true: cancelling a paper leaves the series alone.
 */

export type Actor = { organizationId: string; userId: string; role: string };

export const MAX_NAME = 80;
export const MAX_NOTE = 200;

export type CreateInput = {
  name: string;
  academicYear: string;
  note?: string | null;
};

export type CreateResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid" | "duplicate"; message: string };

export async function createSeries(
  actor: Actor,
  input: CreateInput,
): Promise<CreateResult> {
  const name = input.name.trim();
  const academicYear = input.academicYear.trim();

  if (name.length === 0) {
    return { ok: false, reason: "invalid", message: "Give the series a name." };
  }
  if (name.length > MAX_NAME) {
    return {
      ok: false,
      reason: "invalid",
      message: `That name is longer than ${MAX_NAME} characters.`,
    };
  }
  if (!/^\d{4}-\d{2}$/.test(academicYear)) {
    return {
      ok: false,
      reason: "invalid",
      message: "An academic year looks like 2026-27.",
    };
  }

  const id = randomUUID();
  const created = await withTenant(actor.organizationId, async (tx) => {
    // Two series with the same name in one year are indistinguishable on every
    // screen that lists them, and whichever a paper ends up in is a coin toss —
    // the same reason a duplicate concept name is refused outright.
    //
    // Case, spacing and the separator are all ignored: "Half-Yearly", "Half
    // Yearly" and "half  yearly" are one event to everybody except a database,
    // and a school that typed the second on Tuesday is not naming a second
    // series. The comparison stops there rather than getting clever — "Term 1"
    // and "Term One" are a judgement no rule should make on a teacher's
    // behalf.
    const existing = await tx.examSeries.findMany({
      where: { academicYear, cancelledAt: null },
      select: { name: true },
    });
    const flat = (value: string) =>
      value.toLowerCase().replace(/[\s‐-―_-]+/g, " ").trim();
    // The clash is reported under the name the school already uses, not the one
    // just typed: "2026-27 already has a series called Pre-Boards" is a
    // sentence somebody can go and look at.
    const clash = existing.find((row) => flat(row.name) === flat(name));
    if (clash) return clash.name;

    await tx.examSeries.createMany({
      data: [
        {
          id,
          organizationId: actor.organizationId,
          name,
          academicYear,
          note: input.note?.trim() ? input.note.trim() : null,
          createdById: actor.userId,
        },
      ],
    });
    return null;
  });

  if (created !== null) {
    return {
      ok: false,
      reason: "duplicate",
      message: `${academicYear} already has a series called “${created}”.`,
    };
  }

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "series.created",
    entityType: "exam_series",
    entityId: id,
    after: { name, academicYear },
  });

  return { ok: true, id };
}

export type RenameResult = { ok: boolean };

/**
 * Rename one, or change its note.
 *
 * A rename is not a version: a stamped report already holds the name the
 * series had on the day it was written (`ReportSitting.seriesName`), so
 * correcting a typo here cannot rewrite what a parent was handed in September.
 */
export async function renameSeries(
  actor: Actor,
  id: string,
  input: { name?: string; note?: string | null },
): Promise<RenameResult> {
  const name = input.name?.trim();
  if (name !== undefined && (name.length === 0 || name.length > MAX_NAME)) {
    return { ok: false };
  }

  const before = await withTenant(actor.organizationId, async (tx) => {
    const row = await tx.examSeries.findFirst({ where: { id, cancelledAt: null } });
    if (!row) return null;
    await tx.examSeries.update({
      where: { id },
      data: {
        ...(name === undefined ? {} : { name }),
        ...(input.note === undefined
          ? {}
          : { note: input.note?.trim() ? input.note.trim() : null }),
      },
    });
    return row;
  });
  if (!before) return { ok: false };

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "series.renamed",
    entityType: "exam_series",
    entityId: id,
    before: { name: before.name, note: before.note },
    after: { name: name ?? before.name, note: input.note ?? before.note },
  });
  return { ok: true };
}

/**
 * Withdraw one. A stamp, never a delete, and the papers are left alone.
 *
 * They keep their windows, their students and their marks; they simply stop
 * being grouped. Anything already reported under the name keeps it, because a
 * report stamped the name rather than pointing at this row.
 */
export async function withdrawSeries(
  actor: Actor,
  id: string,
): Promise<{ ok: boolean; papers: number }> {
  const found = await withTenant(actor.organizationId, async (tx) => {
    const row = await tx.examSeries.findFirst({ where: { id, cancelledAt: null } });
    if (!row) return null;
    const papers = await tx.assignment.count({ where: { examSeriesId: id } });
    await tx.examSeries.update({
      where: { id },
      data: { cancelledAt: new Date() },
    });
    return { papers };
  });
  if (!found) return { ok: false, papers: 0 };

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "series.withdrawn",
    entityType: "exam_series",
    entityId: id,
    // How many papers were grouped under it, because "the half-yearly
    // disappeared" is a support question and the answer is that the label went
    // and six papers did not.
    after: { papers: found.papers },
  });
  return { ok: true, papers: found.papers };
}

export type PaperResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "taken"; message: string };

/** Put an existing paper in a series. */
export async function addPaper(
  actor: Actor,
  seriesId: string,
  assignmentId: string,
): Promise<PaperResult> {
  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const series = await tx.examSeries.findFirst({
      where: { id: seriesId, cancelledAt: null },
      select: { id: true },
    });
    if (!series) return "not-found" as const;

    const paper = await tx.assignment.findFirst({
      where: { id: assignmentId },
      select: { id: true, examSeriesId: true },
    });
    if (!paper) return "not-found" as const;
    // A column, so a paper can only be in one series — but say so rather than
    // moving it silently. A paper that quietly left the half-yearly when
    // somebody built the pre-boards is a paper missing from a report nobody
    // will re-read.
    if (paper.examSeriesId !== null && paper.examSeriesId !== seriesId) {
      return "taken" as const;
    }

    await tx.assignment.update({
      where: { id: assignmentId },
      data: { examSeriesId: seriesId },
    });
    return "ok" as const;
  });

  if (outcome === "not-found") {
    return { ok: false, reason: "not-found", message: "We could not find that." };
  }
  if (outcome === "taken") {
    return {
      ok: false,
      reason: "taken",
      message:
        "That paper already belongs to another series. Take it out of that one first.",
    };
  }

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "series.paper_added",
    entityType: "assignment",
    entityId: assignmentId,
    after: { examSeriesId: seriesId },
  });
  return { ok: true };
}

/**
 * Take a paper out of a series.
 *
 * The paper is untouched — same window, same students, same marks. Only the
 * grouping goes.
 */
export async function removePaper(
  actor: Actor,
  seriesId: string,
  assignmentId: string,
): Promise<{ ok: boolean }> {
  const removed = await withTenant(actor.organizationId, async (tx) => {
    const paper = await tx.assignment.findFirst({
      where: { id: assignmentId, examSeriesId: seriesId },
      select: { id: true },
    });
    if (!paper) return false;
    await tx.assignment.update({
      where: { id: assignmentId },
      data: { examSeriesId: null },
    });
    return true;
  });
  if (!removed) return { ok: false };

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "series.paper_removed",
    entityType: "assignment",
    entityId: assignmentId,
    before: { examSeriesId: seriesId },
  });
  return { ok: true };
}

export type SeriesRow = {
  id: string;
  name: string;
  academicYear: string;
  note: string | null;
  status: SeriesStatus;
  papers: number;
  /** From the papers' own windows. Null while it holds nothing. */
  from: Date | null;
  to: Date | null;
};

export async function listSeries(
  organizationId: string,
  filters: { academicYear?: string; includeWithdrawn?: boolean } = {},
  now = new Date(),
): Promise<SeriesRow[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx.examSeries.findMany({
      where: {
        ...(filters.academicYear ? { academicYear: filters.academicYear } : {}),
        ...(filters.includeWithdrawn ? {} : { cancelledAt: null }),
      },
      include: {
        assignments: {
          select: { opensAt: true, closesAt: true, cancelledAt: true },
        },
      },
      orderBy: [{ academicYear: "desc" }, { createdAt: "desc" }],
      take: 100,
    });

    return rows.map((row) => {
      const span = seriesSpan(row.assignments);
      return {
        id: row.id,
        name: row.name,
        academicYear: row.academicYear,
        note: row.note,
        status: seriesStatus(row, row.assignments, now),
        papers: row.assignments.length,
        from: span?.from ?? null,
        to: span?.to ?? null,
      };
    });
  });
}

export type SeriesPaper = {
  assignmentId: string;
  title: string;
  subjectName: string;
  className: string;
  opensAt: Date;
  closesAt: Date;
  status: AssignmentStatus;
  /** Out of how many were expected to sit it, how many have handed in. */
  expected: number;
  satCount: number;
  /**
   * Papers still partly with the teacher. A count, never averaged away and
   * never rounded into a mark.
   */
  awaitingMarking: number;
  resultsReleased: boolean;
};

export type SeriesDetail = SeriesRow & {
  withdrawn: boolean;
  papers: number;
  /** In the order they run, which is the order a term happens in. */
  list: SeriesPaper[];
};

export async function getSeries(
  organizationId: string,
  id: string,
  now = new Date(),
): Promise<SeriesDetail | null> {
  return withTenant(organizationId, async (tx) => {
    const row = await tx.examSeries.findFirst({
      where: { id },
      include: {
        assignments: {
          include: {
            assessment: { select: { title: true, subject: { select: { name: true } } } },
            class: {
              select: {
                name: true,
                _count: { select: { enrolments: { where: { status: "ACTIVE" } } } },
              },
            },
            _count: { select: { targets: true } },
          },
          orderBy: { opensAt: "asc" },
        },
      },
    });
    if (!row) return null;

    const attempts =
      row.assignments.length === 0
        ? []
        : await tx.attempt.findMany({
            where: {
              assignmentId: { in: row.assignments.map((paper) => paper.id) },
              status: { not: "IN_PROGRESS" },
            },
            select: {
              assignmentId: true,
              studentUserId: true,
              answers: { select: { awardedMarks: true, response: true } },
            },
          });

    const list: SeriesPaper[] = row.assignments.map((paper) => {
      const mine = attempts.filter((attempt) => attempt.assignmentId === paper.id);
      // Distinct people, not sittings — the same rule the institute console's
      // `activeStudents` follows. Four goes at one paper is one student who
      // sat it.
      const sat = new Set(mine.map((attempt) => attempt.studentUserId));
      // A paper is awaiting marking when somebody wrote something nobody has
      // read. Counted per SITTING, because that is the unit a marker works in.
      const awaiting = mine.filter((attempt) =>
        attempt.answers.some(
          (answer) => answer.awardedMarks === null && answer.response !== null,
        ),
      ).length;

      return {
        assignmentId: paper.id,
        title: paper.assessment.title,
        subjectName: paper.assessment.subject.name,
        className: paper.class.name,
        opensAt: paper.opensAt,
        closesAt: paper.closesAt,
        status: assignmentStatus(paper, now),
        expected:
          paper._count.targets > 0
            ? paper._count.targets
            : paper.class._count.enrolments,
        satCount: sat.size,
        awaitingMarking: awaiting,
        resultsReleased: paper.resultsReleasedAt !== null,
      };
    });

    const span = seriesSpan(row.assignments);
    return {
      id: row.id,
      name: row.name,
      academicYear: row.academicYear,
      note: row.note,
      status: seriesStatus(row, row.assignments, now),
      papers: row.assignments.length,
      withdrawn: row.cancelledAt !== null,
      from: span?.from ?? null,
      to: span?.to ?? null,
      list,
    };
  });
}

export type Unassigned = {
  assignmentId: string;
  title: string;
  className: string;
  opensAt: Date;
  closesAt: Date;
  status: AssignmentStatus;
};

/**
 * Papers that could join this series: in no series, not cancelled.
 *
 * Every window state is offered, including shut ones. A half-yearly is
 * routinely grouped after the fact — somebody sets six papers in a week and
 * names the event afterwards — and a picker that hid the finished ones would
 * make that impossible.
 */
export async function papersAvailable(
  organizationId: string,
  now = new Date(),
): Promise<Unassigned[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx.assignment.findMany({
      where: { examSeriesId: null, cancelledAt: null },
      include: {
        assessment: { select: { title: true } },
        class: { select: { name: true } },
      },
      orderBy: { opensAt: "desc" },
      take: 60,
    });
    return rows.map((row) => ({
      assignmentId: row.id,
      title: row.assessment.title,
      className: row.class.name,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      status: assignmentStatus(row, now),
    }));
  });
}

export { seriesStatus, seriesSpan };
export type { SeriesStatus };
