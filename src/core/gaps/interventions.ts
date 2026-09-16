import "server-only";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { conceptContext } from "@/core/curriculum/concepts";
import { estimateMastery, type Evidence } from "@/core/mastery/estimate";
import { detectForClass } from "./detect";
import { classVerdict, STUDENT_THRESHOLD, type StudentReading } from "./rules";
import type { Prisma } from "@prisma/client";

/**
 * What somebody did about a gap, and what happened next.
 *
 * ---------------------------------------------------------------------------
 * The baseline is stamped at creation and never touched
 * ---------------------------------------------------------------------------
 * Everything here exists to make one claim falsifiable: *this worked*. Without
 * a number written down before the lesson, "improvement" is measured against
 * whatever mastery happens to be when somebody looks — which always flatters
 * the intervention, and an unfalsifiable improvement claim is the thing that
 * eventually loses the customer.
 *
 * So creation records three things together: what the mastery was, how many
 * students were behind that figure, and what would count as having worked.
 * Measurement compares against those and nothing else.
 *
 * ---------------------------------------------------------------------------
 * A measured failure is worth more than an unmeasured success
 * ---------------------------------------------------------------------------
 * `measure()` records whatever it finds. There is no path that abandons an
 * intervention because the result was disappointing, and the gap it was aimed
 * at goes to PERSISTING on the detection pass that follows the measurement —
 * which is the most important signal the product produces. Not before it: an
 * open intervention is not a failed one, however many papers are submitted
 * while it is open.
 */

export type Actor = { organizationId: string; userId: string; role: string };

export type Kind = "REMEDIAL_ASSESSMENT" | "PRACTICE_SET" | "LESSON_PLAN" | "MANUAL";

/**
 * How much better it should be for this to have been worth doing.
 *
 * The student threshold plus a margin, floored at the baseline so a target is
 * never behind where the class already was. Not a stretch goal — the point at
 * which a teacher would say the lesson landed.
 */
export function targetFor(baseline: number): number {
  return Math.min(0.95, Math.max(baseline + 0.15, STUDENT_THRESHOLD + 0.05));
}

/**
 * A miss and a refusal are different answers, and the API says so.
 *
 * NOT_FOUND covers a gap this tenant cannot see — which is exactly what a gap
 * belonging to somebody else looks like, and must be indistinguishable from a
 * gap that never existed. CONFLICT is a real refusal about a row the caller can
 * see.
 */
export type Refusal = "NOT_FOUND" | "CONFLICT";

export type CreateResult =
  | { ok: true; interventionId: string; baseline: number; target: number }
  | { ok: false; reason: Refusal; message: string };

export async function planIntervention(
  actor: Actor,
  gapId: string,
  input: { kind: Kind; note?: string | null },
  now = new Date(),
): Promise<CreateResult> {
  const outcome = await withTenant<CreateResult>(
    actor.organizationId,
    async (tx) => {
      const gap = await tx.learningGap.findFirst({ where: { id: gapId } });
      if (!gap) {
        return { ok: false, reason: "NOT_FOUND", message: "We could not find that gap." };
      }

      if (gap.status === "RESOLVED") {
        return {
          ok: false,
          reason: "CONFLICT",
          message:
            "That gap has already closed — the evidence no longer shows it, so there is nothing to intervene on.",
        };
      }

      const open = await tx.intervention.findFirst({
        where: { learningGapId: gapId, status: { in: ["PLANNED", "ACTIVE"] } },
      });
      if (open) {
        // Two open interventions on one gap makes the measurement meaningless:
        // whichever is measured second takes credit for both.
        return {
          ok: false,
          reason: "CONFLICT",
          message:
            "There is already something in progress against this gap. Measure it before starting another, or the result belongs to neither.",
        };
      }

      const baseline = Number(gap.meanEstimate);
      const target = targetFor(baseline);

      const created = await tx.intervention.create({
        data: {
          organizationId: actor.organizationId,
          learningGapId: gapId,
          createdById: actor.userId,
          kind: input.kind,
          baselineMastery: baseline,
          baselineStudentCount: gap.affectedStudentCount,
          targetMastery: target,
          status: "ACTIVE",
          note: input.note?.trim() ? input.note.trim().slice(0, 1000) : null,
          createdAt: now,
        },
      });

      // The gap is now being worked on. That matters at the next detection
      // pass: if it survives, it becomes PERSISTING rather than looking like a
      // fresh finding.
      await tx.learningGap.update({
        where: { id: gapId },
        data: { status: "INTERVENING" },
      });

      return {
        ok: true,
        interventionId: created.id,
        baseline,
        target,
      };
    },
  );

  if (outcome.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "intervention.planned",
      entityType: "intervention",
      entityId: outcome.interventionId,
      after: { gapId, kind: input.kind, baseline: outcome.baseline },
    });
  }

  return outcome;
}

export type MeasureResult =
  | {
      ok: true;
      baseline: number;
      outcome: number;
      target: number;
      delta: number;
      metTarget: boolean;
      studentsNow: number;
      /** False when there is no longer enough evidence to compare against. */
      comparable: boolean;
      /** The students who were behind when it started, read again. See `BaselineCohort`. */
      cohort: BaselineCohort;
      /** Which gap it was for, so detection can run for its class afterwards. */
      gapScope: { scope: string; scopeId: string };
    }
  | { ok: false; reason: Refusal; message: string };

/**
 * The ORIGINAL cohort, read again — shown beside the outcome, never instead of it.
 *
 * `outcome` is the mean over whoever is struggling at the moment of measuring,
 * and that rule stands. But it answers "how far behind are the students who
 * are still behind", which is not the question a teacher reads it as. After a
 * lesson that worked for most of the room, the two left below the line can
 * average lower than the eight who were there before — and the figure reads as
 * the lesson having made things worse.
 *
 * So the students the baseline described are followed as well. Nothing stores
 * who they were, and this does not need it to: a remedial paper's targets ARE
 * that group, and for anything else the evidence ledger answers "who was below
 * the line on the day this started" by running the same pure estimator over the
 * rows known on that day. Both readings come from the ledger, so the pair is
 * re-derivable by anybody, later.
 *
 * `mean` is null when none of them has enough evidence. Null, not zero.
 */
export type BaselineCohort = {
  /** How many students the cohort holds. */
  students: number;
  /** How many of them have a real estimate as of the reading. */
  measured: number;
  mean: number | null;
  /** How the cohort was identified, so the screen can say so. */
  source: "remedial-targets" | "ledger";
};

async function baselineCohort(
  tx: Prisma.TransactionClient,
  intervention: { assignmentId: string | null; createdAt: Date },
  gap: { scope: string; scopeId: string; conceptId: string },
  asOf: Date,
): Promise<BaselineCohort> {
  const targets = intervention.assignmentId
    ? await tx.assignmentTarget.findMany({
        where: { assignmentId: intervention.assignmentId },
        select: { studentUserId: true },
      })
    : [];

  const candidates =
    targets.length > 0
      ? targets.map((row) => row.studentUserId)
      : gap.scope === "CLASS"
        ? (
            await tx.classEnrolment.findMany({
              where: { classId: gap.scopeId },
              select: { studentUserId: true },
            })
          ).map((row) => row.studentUserId)
        : [gap.scopeId];
  const ids = [...new Set(candidates)];

  const evidence =
    ids.length === 0
      ? []
      : await tx.conceptEvidence.findMany({
          where: {
            conceptId: gap.conceptId,
            studentUserId: { in: ids },
            observedAt: { lte: asOf },
          },
          select: {
            studentUserId: true,
            score: true,
            difficulty: true,
            weight: true,
            observedAt: true,
          },
        });

  const byStudent = new Map<string, Evidence[]>();
  for (const row of evidence) {
    const list = byStudent.get(row.studentUserId) ?? [];
    list.push({
      score: Number(row.score),
      difficulty: row.difficulty as Evidence["difficulty"],
      mapping: Number(row.weight),
      observedAt: row.observedAt,
    });
    byStudent.set(row.studentUserId, list);
  }

  const estimateAt = (studentUserId: string, at: Date): number | null => {
    const rows = (byStudent.get(studentUserId) ?? []).filter(
      (row) => row.observedAt <= at,
    );
    const reading = estimateMastery(rows, at);
    return reading.band === "INSUFFICIENT" ? null : reading.estimate;
  };

  // A remedial paper's targets are the cohort by definition. Anything else is
  // re-derived: the students whose estimate, as known the day it started, was
  // below the line.
  const cohort =
    targets.length > 0
      ? ids
      : ids.filter((id) => {
          const then = estimateAt(id, intervention.createdAt);
          return then !== null && then < STUDENT_THRESHOLD;
        });

  const readings = cohort
    .map((id) => estimateAt(id, asOf))
    .filter((value): value is number => value !== null);

  return {
    students: cohort.length,
    measured: readings.length,
    mean:
      readings.length === 0
        ? null
        : Math.round(
            (readings.reduce((sum, value) => sum + value, 0) / readings.length) * 1000,
          ) / 1000,
    source: targets.length > 0 ? "remedial-targets" : "ledger",
  };
}

/**
 * Read the current mastery for the gap's concept and cohort, and record it.
 *
 * Deliberately re-derives from `student_concept_mastery` rather than trusting
 * the gap row: a gap that has since resolved has no current mean of its own,
 * and the measurement needs the number even so.
 */
export async function measureIntervention(
  actor: Actor,
  interventionId: string,
  now = new Date(),
): Promise<MeasureResult> {
  const outcome = await withTenant<MeasureResult>(
    actor.organizationId,
    async (tx) => {
      const intervention = await tx.intervention.findFirst({
        where: { id: interventionId },
      });
      if (!intervention) {
        return { ok: false, reason: "NOT_FOUND", message: "We could not find that." };
      }
      if (intervention.status === "MEASURED") {
        return {
          ok: false,
          reason: "CONFLICT",
          message: "That has already been measured. Its result does not change.",
        };
      }

      const gap = await tx.learningGap.findFirst({
        where: { id: intervention.learningGapId },
      });
      if (!gap) {
        return {
          ok: false,
          reason: "NOT_FOUND",
          message: "We could not find the gap it was for.",
        };
      }

      // The same cohort the gap was about: the class it was found in, as it
      // stands now. A student who joined since is included — they sat the
      // lesson too — and one who left is not.
      const enrolments =
        gap.scope === "CLASS"
          ? await tx.classEnrolment.findMany({
              where: { classId: gap.scopeId, status: "ACTIVE" },
              select: { studentUserId: true },
            })
          : [{ studentUserId: gap.scopeId }];

      const rows = await tx.studentConceptMastery.findMany({
        where: {
          conceptId: gap.conceptId,
          studentUserId: { in: enrolments.map((e) => e.studentUserId) },
        },
      });

      const readings: StudentReading[] = rows.map((row) => ({
        studentUserId: row.studentUserId,
        estimate: row.estimate === null ? null : Number(row.estimate),
        band: row.band as StudentReading["band"],
      }));

      const measured = readings.filter((reading) => reading.estimate !== null);
      const baseline = Number(intervention.baselineMastery);
      const target = Number(intervention.targetMastery);

      if (measured.length === 0) {
        // Nothing to compare against. Recorded as such rather than as a zero,
        // which would read as "it made them worse".
        return {
          ok: false,
          reason: "CONFLICT",
          message:
            "Nobody in this group has enough evidence yet. Set them something and measure after it has been marked.",
        };
      }

      // The mean over the same population the baseline described: the students
      // who are struggling now, or everyone measured if none is. Comparing a
      // struggling-students mean against a whole-class mean would show
      // improvement whenever the strugglers simply stopped being counted.
      const struggling = measured.filter(
        (reading) => (reading.estimate ?? 1) < STUDENT_THRESHOLD,
      );
      const population = struggling.length > 0 ? struggling : measured;
      const current =
        population.reduce((sum, reading) => sum + (reading.estimate ?? 0), 0) /
        population.length;

      const rounded = Math.round(current * 1000) / 1000;

      await tx.intervention.update({
        where: { id: interventionId },
        data: {
          outcomeMastery: rounded,
          outcomeStudentCount: population.length,
          status: "MEASURED",
          measuredAt: now,
        },
      });

      // Whether the gap itself is still there is a separate question, answered
      // by detection on the evidence — not by this.
      const verdict = classVerdict(readings);

      const cohort = await baselineCohort(tx, intervention, gap, now);

      return {
        ok: true,
        baseline,
        outcome: rounded,
        target,
        delta: Math.round((rounded - baseline) * 1000) / 1000,
        metTarget: rounded >= target,
        studentsNow: population.length,
        comparable: verdict.measured >= intervention.baselineStudentCount / 2,
        cohort,
        gapScope: { scope: gap.scope, scopeId: gap.scopeId },
      };
    },
  );

  if (outcome.ok && outcome.gapScope.scope === "CLASS") {
    // Detection straight away rather than at the next submission, so a missed
    // target shows as PERSISTING on the page the teacher is looking at. A
    // student gap has no class to reconcile here and waits for the next pass.
    try {
      await detectForClass(actor.organizationId, outcome.gapScope.scopeId, now);
    } catch (error) {
      // The measurement is recorded; a derived table that could not be
      // reconciled is fixed by the next pass.
      console.error(`[gaps] detection after measuring ${interventionId} failed:`, error);
    }
  }

  if (outcome.ok) {
    await writeAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "intervention.measured",
      entityType: "intervention",
      entityId: interventionId,
      after: {
        baseline: outcome.baseline,
        outcome: outcome.outcome,
        metTarget: outcome.metTarget,
      },
    });
  }

  return outcome;
}

export type InterventionRow = {
  id: string;
  gapId: string;
  conceptId: string;
  conceptName: string;
  kind: string;
  status: string;
  /** Set only for a paper this built. The teacher's way back to who has sat it. */
  assignmentId: string | null;
  baselineMastery: number;
  baselineStudentCount: number;
  targetMastery: number;
  outcomeMastery: number | null;
  outcomeStudentCount: number | null;
  delta: number | null;
  metTarget: boolean | null;
  /** The original cohort, read as of the day it was measured. Null until then. */
  cohort: BaselineCohort | null;
  note: string | null;
  createdAt: Date;
  measuredAt: Date | null;
};

export async function listInterventions(
  organizationId: string,
  classId?: string,
): Promise<InterventionRow[]> {
  const rows = await withTenant(organizationId, async (tx) => {
    const gaps = classId
      ? await tx.learningGap.findMany({
          where: { scope: "CLASS", scopeId: classId },
          select: { id: true },
        })
      : null;

    return tx.intervention.findMany({
      where: gaps ? { learningGapId: { in: gaps.map((gap) => gap.id) } } : {},
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });
  if (rows.length === 0) return [];

  const gaps = await withTenant(organizationId, (tx) =>
    tx.learningGap.findMany({
      where: { id: { in: rows.map((row) => row.learningGapId) } },
      select: { id: true, conceptId: true },
    }),
  );
  const conceptByGap = new Map(gaps.map((gap) => [gap.id, gap.conceptId]));
  const context = await conceptContext([...new Set(gaps.map((gap) => gap.conceptId))]);

  // Read as of the day each was measured, so the figure beside a stamped
  // outcome does not drift as later evidence arrives.
  const cohorts = new Map<string, BaselineCohort>();
  const measured = rows.filter((row) => row.status === "MEASURED" && row.measuredAt);
  if (measured.length > 0) {
    await withTenant(organizationId, async (tx) => {
      const fullGaps = await tx.learningGap.findMany({
        where: { id: { in: measured.map((row) => row.learningGapId) } },
        select: { id: true, scope: true, scopeId: true, conceptId: true },
      });
      const gapById = new Map(fullGaps.map((gap) => [gap.id, gap]));
      for (const row of measured) {
        const gap = gapById.get(row.learningGapId);
        if (!gap) continue;
        cohorts.set(row.id, await baselineCohort(tx, row, gap, row.measuredAt!));
      }
    });
  }

  return rows.map((row) => {
    const conceptId = conceptByGap.get(row.learningGapId) ?? "";
    const baseline = Number(row.baselineMastery);
    const outcome = row.outcomeMastery === null ? null : Number(row.outcomeMastery);

    return {
      id: row.id,
      gapId: row.learningGapId,
      conceptId,
      conceptName: context.get(conceptId)?.name ?? "Unknown concept",
      kind: row.kind,
      status: row.status,
      assignmentId: row.assignmentId,
      baselineMastery: baseline,
      baselineStudentCount: row.baselineStudentCount,
      targetMastery: Number(row.targetMastery),
      outcomeMastery: outcome,
      outcomeStudentCount: row.outcomeStudentCount,
      // Null until measured. Not zero — "no change" and "not yet measured" are
      // opposite claims about whether the lesson worked.
      delta: outcome === null ? null : Math.round((outcome - baseline) * 1000) / 1000,
      metTarget: outcome === null ? null : outcome >= Number(row.targetMastery),
      cohort: cohorts.get(row.id) ?? null,
      note: row.note,
      createdAt: row.createdAt,
      measuredAt: row.measuredAt,
    };
  });
}
