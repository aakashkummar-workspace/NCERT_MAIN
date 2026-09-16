import "server-only";
import { withTenant } from "@/db/tenant";
import { conceptContext } from "@/core/curriculum/concepts";

/**
 * Reading gaps.
 *
 * Ordered so the first row is the one to act on: open before closed, severe
 * before mild, and within a severity, the one affecting the most students.
 * A list a teacher has to sort themselves is a list they sort once.
 */

export type Severity = "HIGH" | "MEDIUM" | "LOW";
export type GapStatus =
  | "DETECTED"
  | "ACKNOWLEDGED"
  | "INTERVENING"
  | "RESOLVED"
  | "PERSISTING";

export type Gap = {
  id: string;
  scope: "STUDENT" | "CLASS";
  scopeId: string;
  conceptId: string;
  conceptName: string;
  chapters: string[];
  severity: Severity;
  status: GapStatus;
  affectedStudentCount: number;
  measuredStudentCount: number;
  meanEstimate: number;
  /** What to teach first, when the class is weak on a foundation as well. */
  rootCauseConceptId: string | null;
  rootCauseName: string | null;
  detectedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
};

const SEVERITY_ORDER: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** Open first. A resolved gap is history, not a task. */
const STATUS_ORDER: Record<GapStatus, number> = {
  // A gap that survived an intervention leads, because it says the thing that
  // was tried did not work — the most important signal on the page.
  PERSISTING: 0,
  DETECTED: 1,
  ACKNOWLEDGED: 2,
  INTERVENING: 3,
  RESOLVED: 4,
};

export async function classGaps(
  organizationId: string,
  classId: string,
  options: { includeResolved?: boolean } = {},
): Promise<Gap[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.learningGap.findMany({
      where: {
        scope: "CLASS",
        scopeId: classId,
        ...(options.includeResolved ? {} : { status: { not: "RESOLVED" } }),
      },
    }),
  );
  return decorate(rows);
}

export type OpenClassGap = Gap & { className: string };

export type GapSummary = {
  /** Open class gaps across the organization, in the order to act on them. */
  gaps: OpenClassGap[];
  /**
   * Interventions still waiting to be measured, and how many of those are on a
   * gap the evidence has already closed — the success case, which is the one
   * that goes unrecorded if nobody is told.
   */
  toMeasure: { total: number; onClosedGaps: number; classIds: string[] };
};

/**
 * The dashboard's view of gaps: every open class gap in the organization,
 * ordered the same way the gaps page orders them.
 */
export async function gapSummary(organizationId: string): Promise<GapSummary> {
  const data = await withTenant(organizationId, async (tx) => {
    const rows = await tx.learningGap.findMany({
      where: { scope: "CLASS", status: { not: "RESOLVED" } },
    });
    const classes = await tx.class.findMany({
      where: { id: { in: rows.map((row) => row.scopeId) }, deletedAt: null },
      select: { id: true, name: true },
    });
    const open = await tx.intervention.findMany({
      where: { status: { in: ["PLANNED", "ACTIVE"] } },
      select: { learningGapId: true },
    });
    const openGaps =
      open.length === 0
        ? []
        : await tx.learningGap.findMany({
            where: { id: { in: open.map((row) => row.learningGapId) } },
            select: { status: true, scope: true, scopeId: true },
          });
    return { rows, classes, open, openGaps };
  });

  const nameById = new Map(data.classes.map((row) => [row.id, row.name]));
  const decorated = await decorate(
    data.rows.filter((row) => nameById.has(row.scopeId)),
  );

  return {
    // Severity first across classes — the dashboard is choosing which class to
    // open — and the gaps page's own order within a severity, so a gap that
    // survived a measured intervention still leads its level.
    gaps: decorated
      .map((gap) => ({ ...gap, className: nameById.get(gap.scopeId) ?? "" }))
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          b.affectedStudentCount - a.affectedStudentCount,
      ),
    toMeasure: {
      total: data.open.length,
      onClosedGaps: data.openGaps.filter((gap) => gap.status === "RESOLVED").length,
      classIds: [
        ...new Set(
          data.openGaps.filter((gap) => gap.scope === "CLASS").map((gap) => gap.scopeId),
        ),
      ],
    },
  };
}

export async function studentGaps(
  organizationId: string,
  studentUserId: string,
): Promise<Gap[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.learningGap.findMany({
      where: { scope: "STUDENT", scopeId: studentUserId, status: { not: "RESOLVED" } },
    }),
  );
  return decorate(rows);
}

type Row = {
  id: string;
  scope: string;
  scopeId: string;
  conceptId: string;
  severity: string;
  status: string;
  affectedStudentCount: number;
  measuredStudentCount: number;
  meanEstimate: unknown;
  rootCauseConceptId: string | null;
  detectedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
};

async function decorate(rows: Row[]): Promise<Gap[]> {
  if (rows.length === 0) return [];

  const context = await conceptContext([
    ...new Set([
      ...rows.map((row) => row.conceptId),
      ...rows.flatMap((row) => (row.rootCauseConceptId ? [row.rootCauseConceptId] : [])),
    ]),
  ]);

  return rows
    .map((row) => ({
      id: row.id,
      scope: row.scope as Gap["scope"],
      scopeId: row.scopeId,
      conceptId: row.conceptId,
      conceptName: context.get(row.conceptId)?.name ?? "Unknown concept",
      chapters: context.get(row.conceptId)?.chapters ?? [],
      severity: row.severity as Severity,
      status: row.status as GapStatus,
      affectedStudentCount: row.affectedStudentCount,
      measuredStudentCount: row.measuredStudentCount,
      meanEstimate: Number(row.meanEstimate),
      rootCauseConceptId: row.rootCauseConceptId,
      rootCauseName: row.rootCauseConceptId
        ? (context.get(row.rootCauseConceptId)?.name ?? null)
        : null,
      detectedAt: row.detectedAt,
      lastSeenAt: row.lastSeenAt,
      resolvedAt: row.resolvedAt,
    }))
    .sort((a, b) => {
      const status = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (status !== 0) return status;
      const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (severity !== 0) return severity;
      return b.affectedStudentCount - a.affectedStudentCount;
    });
}

export type AcknowledgeResult =
  | { ok: true; status: GapStatus }
  | { ok: false; message: string };

/**
 * Say you have seen it.
 *
 * Acknowledging is not resolving, and the API has no way to do the second.
 * A gap closes when the evidence closes it — a teacher who could dismiss one
 * would be maintaining a tidy dashboard rather than teaching a concept, and the
 * number on it would stop meaning anything within a term.
 */
export async function acknowledgeGap(
  actor: { organizationId: string; userId: string },
  gapId: string,
  now = new Date(),
): Promise<AcknowledgeResult> {
  return withTenant<AcknowledgeResult>(actor.organizationId, async (tx) => {
    const gap = await tx.learningGap.findFirst({ where: { id: gapId } });
    if (!gap) return { ok: false, message: "We could not find that gap." };

    if (gap.status === "RESOLVED") {
      return {
        ok: false,
        message: "That gap has already closed — the evidence no longer shows it.",
      };
    }

    const updated = await tx.learningGap.update({
      where: { id: gapId },
      data: {
        status: "ACKNOWLEDGED",
        acknowledgedAt: now,
        acknowledgedById: actor.userId,
      },
    });
    return { ok: true, status: updated.status as GapStatus };
  });
}
