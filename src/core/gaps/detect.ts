import "server-only";
import { withTenant } from "@/db/tenant";
import { prerequisitesOf } from "@/core/curriculum/concepts";
import {
  classVerdict,
  interventionStateOf,
  isStudentGap,
  rootCause,
  studentSeverity,
  transitionFor,
  type StudentReading,
} from "./rules";

/**
 * Turning mastery into something to do on Monday.
 *
 * Detection is a pass, not a trigger. It reads the current estimates, decides
 * what is a gap by the rules in `./rules`, and reconciles the `learning_gaps`
 * table against that answer — opening what is new, re-stamping what is still
 * true, and resolving what is not.
 *
 * ---------------------------------------------------------------------------
 * Reconciliation, not accumulation
 * ---------------------------------------------------------------------------
 * The table is derived. Running detection twice with unchanged evidence must
 * leave it exactly as it was, and running it after a class improves must close
 * the gaps that improved — **without a teacher doing anything**. A gap list
 * that only ever grows is a list nobody reads by March.
 *
 * The one thing detection may not do is resolve a gap for any reason other
 * than the evidence. Not age, not a teacher clicking done. See `transitionFor`.
 */

export type Actor = { organizationId: string; userId: string };

export type DetectReport = {
  classId: string;
  opened: number;
  persisting: number;
  confirmed: number;
  resolved: number;
};

export async function detectForClass(
  organizationId: string,
  classId: string,
  now = new Date(),
): Promise<DetectReport | null> {
  const data = await withTenant(organizationId, async (tx) => {
    const klass = await tx.class.findFirst({
      where: { id: classId, deletedAt: null },
      select: { id: true },
    });
    if (!klass) return null;

    const enrolments = await tx.classEnrolment.findMany({
      where: { classId, status: "ACTIVE" },
      select: { studentUserId: true },
    });
    const studentIds = enrolments.map((enrolment) => enrolment.studentUserId);

    const mastery =
      studentIds.length === 0
        ? []
        : await tx.studentConceptMastery.findMany({
            where: { studentUserId: { in: studentIds } },
          });

    const existing = await tx.learningGap.findMany({
      where: {
        OR: [
          { scope: "CLASS", scopeId: classId },
          { scope: "STUDENT", scopeId: { in: studentIds.length > 0 ? studentIds : [classId] } },
        ],
      },
    });

    // Every intervention on those gaps, newest first — PERSISTING is a claim
    // only a measurement can make, so detection has to know whether one exists.
    const interventions =
      existing.length === 0
        ? []
        : await tx.intervention.findMany({
            where: { learningGapId: { in: existing.map((row) => row.id) } },
            select: {
              learningGapId: true,
              status: true,
              outcomeMastery: true,
              targetMastery: true,
            },
            orderBy: { createdAt: "desc" },
          });

    return { studentIds, mastery, existing, interventions };
  });

  if (!data) return null;
  const { mastery, existing } = data;

  const interventionsByGap = new Map<
    string,
    { status: string; outcomeMastery: number | null; targetMastery: number }[]
  >();
  for (const row of data.interventions) {
    const list = interventionsByGap.get(row.learningGapId) ?? [];
    list.push({
      status: row.status,
      outcomeMastery: row.outcomeMastery === null ? null : Number(row.outcomeMastery),
      targetMastery: Number(row.targetMastery),
    });
    interventionsByGap.set(row.learningGapId, list);
  }

  const readingsByConcept = new Map<string, StudentReading[]>();
  for (const row of mastery) {
    const list = readingsByConcept.get(row.conceptId) ?? [];
    list.push({
      studentUserId: row.studentUserId,
      estimate: row.estimate === null ? null : Number(row.estimate),
      band: row.band as StudentReading["band"],
    });
    readingsByConcept.set(row.conceptId, list);
  }

  // Every concept anybody in this class has been measured on, and the class
  // mean per concept — needed for the root-cause lookup below.
  const conceptIds = [...readingsByConcept.keys()];
  const prerequisites = await prerequisitesOf(conceptIds);

  const meanByConcept = new Map<string, number | null>();
  for (const [conceptId, readings] of readingsByConcept) {
    const measured = readings.filter((reading) => reading.estimate !== null);
    meanByConcept.set(
      conceptId,
      measured.length === 0
        ? null
        : measured.reduce((sum, reading) => sum + (reading.estimate ?? 0), 0) /
            measured.length,
    );
  }

  type Wanted = {
    scope: "CLASS" | "STUDENT";
    scopeId: string;
    conceptId: string;
    severity: "HIGH" | "MEDIUM" | "LOW";
    affected: number;
    measured: number;
    mean: number;
    rootCauseConceptId: string | null;
  };

  const wanted: Wanted[] = [];

  for (const [conceptId, readings] of readingsByConcept) {
    const cause = rootCause(
      (prerequisites.get(conceptId) ?? []).map((prerequisiteId) => ({
        conceptId: prerequisiteId,
        meanEstimate: meanByConcept.get(prerequisiteId) ?? null,
      })),
    );

    const verdict = classVerdict(readings);
    if (verdict.gap) {
      wanted.push({
        scope: "CLASS",
        scopeId: classId,
        conceptId,
        severity: verdict.severity,
        affected: verdict.struggling,
        measured: verdict.measured,
        mean: verdict.meanEstimate,
        rootCauseConceptId: cause,
      });
    }

    for (const reading of readings) {
      if (!isStudentGap(reading)) continue;
      wanted.push({
        scope: "STUDENT",
        scopeId: reading.studentUserId,
        conceptId,
        severity: studentSeverity(reading.estimate ?? 0),
        affected: 1,
        measured: 1,
        mean: reading.estimate ?? 0,
        rootCauseConceptId: cause,
      });
    }
  }

  const key = (scope: string, scopeId: string, conceptId: string) =>
    `${scope}:${scopeId}:${conceptId}`;
  const wantedByKey = new Map(
    wanted.map((item) => [key(item.scope, item.scopeId, item.conceptId), item]),
  );
  const existingByKey = new Map(
    existing.map((row) => [key(row.scope, row.scopeId, row.conceptId), row]),
  );

  const report: DetectReport = {
    classId,
    opened: 0,
    persisting: 0,
    confirmed: 0,
    resolved: 0,
  };

  await withTenant(organizationId, async (tx) => {
    for (const [id, item] of wantedByKey) {
      const previous = existingByKey.get(id);
      const transition = transitionFor(
        previous?.status ?? null,
        true,
        previous ? interventionStateOf(interventionsByGap.get(previous.id) ?? []) : "NONE",
      );

      if (!previous) {
        await tx.learningGap.create({
          data: {
            organizationId,
            scope: item.scope,
            scopeId: item.scopeId,
            conceptId: item.conceptId,
            severity: item.severity,
            status: "DETECTED",
            affectedStudentCount: item.affected,
            measuredStudentCount: item.measured,
            meanEstimate: item.mean,
            rootCauseConceptId: item.rootCauseConceptId,
            detectedAt: now,
            lastSeenAt: now,
          },
        });
        report.opened++;
        continue;
      }

      await tx.learningGap.update({
        where: { id: previous.id },
        data: {
          severity: item.severity,
          status: transition.status,
          affectedStudentCount: item.affected,
          measuredStudentCount: item.measured,
          meanEstimate: item.mean,
          rootCauseConceptId: item.rootCauseConceptId,
          // detectedAt is NOT touched. "How long has this been true" only has
          // an answer if the first sighting stays put.
          lastSeenAt: now,
          resolvedAt: null,
        },
      });
      if (transition.status === "PERSISTING") report.persisting++;
      else report.confirmed++;
    }

    for (const [id, row] of existingByKey) {
      if (wantedByKey.has(id)) continue;
      if (row.status === "RESOLVED") continue;
      // The evidence no longer supports it. This is the ONLY way a gap closes.
      await tx.learningGap.update({
        where: { id: row.id },
        data: { status: "RESOLVED", resolvedAt: now, lastSeenAt: now },
      });
      report.resolved++;
    }
  });

  return report;
}
