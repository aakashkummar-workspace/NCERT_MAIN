import "server-only";
import { withTenant } from "@/db/tenant";
import { conceptContext } from "@/core/curriculum/concepts";
import { MIN_MEASURED } from "@/core/analytics/class";
import { STUDENT_THRESHOLD } from "@/core/gaps/rules";
import { bandFor, type Band } from "@/core/mastery/estimate";

/**
 * Institute-level advanced analytics.
 *
 * ---------------------------------------------------------------------------
 * What this page is FOR
 * ---------------------------------------------------------------------------
 * `core/institute/batches.ts` answers "how is each class doing". That is a
 * comparison an owner can already do in a spreadsheet, given the numbers. This
 * module answers the three questions a spreadsheet cannot:
 *
 *   1. Which ideas are weak in MORE THAN ONE class? A concept below the line in
 *      one room is that room. The same concept below the line in three rooms is
 *      the material, the order it is taught in, or the time it is given — and
 *      those need a completely different response. Telling the two apart is
 *      most of what an owner is for, and it is the most valuable thing here.
 *   2. Which cohorts cannot be compared at all, and why? A refusal is a finding:
 *      "we can tell you nothing about 10-C because 1 of 30 students has enough
 *      evidence" is a sentence somebody can act on this week.
 *   3. Has anything actually improved — measured against a baseline stamped
 *      BEFORE the teaching, never against whatever the number happens to be
 *      when somebody looks.
 *
 * Every one of those ends in something to do. An insight that cannot be acted
 * on gets ignored, and then so do the others — the same lesson the exceptions
 * list on `/institute` learned first.
 *
 * ---------------------------------------------------------------------------
 * Nothing here ranks a teacher, and nothing here ever will
 * ---------------------------------------------------------------------------
 * Not one function in this file reads `class_teachers`, `memberships` or a user
 * row, and no returned type carries a teacher id, a teacher name, or anything
 * that could be joined to one. That is not an oversight to be tidied up later.
 *
 * Ranking teachers by their students' mastery is confounded before it is
 * unfair: a teacher handed the bottom set scores lower on every absolute
 * measure however well they teach, and *which students you were given* dwarfs
 * everything this product can observe. Worse, once teachers know they are
 * ranked on it, avoiding the students who need them most becomes the rational
 * move — the exact opposite of what the product is for.
 *
 * A cohort is a group of students, and a difference between cohorts is a fact
 * about the students. It becomes a claim about a person only if somebody joins
 * it to the timetable, so this module gives them nothing to join it with. If
 * teacher effectiveness is ever measured, the only defensible shape is the one
 * `core/gaps/interventions.ts` already uses and `improvementFromStamps` reads
 * below — improvement against a baseline stamped before the teaching, on the
 * same cohort.
 *
 * ---------------------------------------------------------------------------
 * And there is no single "institute score"
 * ---------------------------------------------------------------------------
 * For the same reason `core/analytics/class.ts` refuses a single "class
 * mastery": averaging across concepts produces a number that moves when the
 * syllabus moves, and it is precisely the number that would be printed on a
 * report and compared between branches, between years, and eventually between
 * teachers. Every figure below is about one cohort or one concept, and every
 * one of them carries the denominator it was computed over.
 */

const DAY = 86_400_000;

/**
 * Below this a cohort or a concept is "weak" here.
 *
 * The same line `core/gaps/rules.ts` calls a student gap at, imported rather
 * than repeated: an owner told a concept is weak and a teacher told it is a gap
 * must be reading one fact, not two that nearly agree.
 */
export { MIN_MEASURED, STUDENT_THRESHOLD };

/**
 * A concept needs this many classes with real evidence before "weak in more
 * than one class" means anything at all.
 *
 * Two, because that is the smallest number for which "everywhere" and "one
 * room" are different sentences. With one class there is no comparison to make,
 * and presenting one as though there were is how a page invents a finding.
 */
export const MIN_COMPARABLE_CLASSES = 2;

/**
 * And this many measured interventions before an institute-wide improvement
 * claim is made.
 *
 * Deliberately the same shape of bar as `MIN_MEASURED`, on a different
 * denominator: that one counts students, this one counts measurements. One
 * intervention that worked is a real, falsifiable claim about that
 * intervention — it is reported, in full, on its own. It is not a trend, and
 * calling it one is how "our reteaching works" gets onto a slide.
 */
export const MIN_MEASURED_OUTCOMES = 3;

/**
 * An intervention running longer than this with no measurement is an exception.
 *
 * Three weeks: long enough for a reteaching to have happened and for the class
 * to have sat something afterwards. An unmeasured intervention is an
 * improvement claim nobody can check, which is the one thing this product is
 * built not to produce.
 */
export const INTERVENTION_STALE_DAYS = 21;

const pct = (value: number) => `${Math.round(value * 100)}%`;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const points = (delta: number) =>
  `${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta * 100))}`;

/* ========================================================================== */
/* Cohort comparison — pure                                                    */
/* ========================================================================== */

export type CohortInput = {
  classId: string;
  className: string;
  subjectName: string;
  academicYear: string;
  /** Everyone on the roster. The denominator every figure below carries. */
  studentIds: string[];
  /**
   * One row per student per concept that has a real estimate. Students the
   * estimator refused for are simply absent — neither struggling nor fine.
   */
  readings: { studentUserId: string; estimate: number }[];
};

export type CohortRow = {
  classId: string;
  className: string;
  subjectName: string;
  academicYear: string;
  students: number;
  /** Students with an estimate on at least one concept. */
  measured: number;
  /** Null below MIN_MEASURED. Never a mean over two students called a cohort. */
  meanEstimate: number | null;
  band: Band | null;
  /** Measured students whose own mean is below the line. Null when refused. */
  struggling: number | null;
  /** Whether this cohort can be compared with another at all. */
  comparable: boolean;
  /** The figure WITH its denominator, ready to print. Never a bare percentage. */
  sentence: string;
};

/**
 * One row per class, each carrying what it was computed over.
 *
 * ---------------------------------------------------------------------------
 * Per student first, then across students
 * ---------------------------------------------------------------------------
 * The obvious implementation averages every mastery row in the class. It is
 * wrong in a way that is invisible: a keen student with thirty measured
 * concepts then counts seven times as much as a student with four, so the
 * cohort figure moves when one student sits another paper and nobody else does
 * anything. Every student gets one vote here, whatever they have sat.
 *
 * `core/institute/batches.ts` computes the same figure the same way, and an
 * integration test asserts the two agree. Two screens disagreeing about a
 * cohort's number — or about whether it exists — is worse than either rule on
 * its own.
 */
export function cohortRows(inputs: CohortInput[]): CohortRow[] {
  const rows = inputs.map((input): CohortRow => {
    const enrolled = new Set(input.studentIds);

    const byStudent = new Map<string, number[]>();
    for (const reading of input.readings) {
      if (!enrolled.has(reading.studentUserId)) continue;
      const list = byStudent.get(reading.studentUserId) ?? [];
      list.push(reading.estimate);
      byStudent.set(reading.studentUserId, list);
    }

    const studentMeans = [...byStudent.values()].map(mean);
    const measured = studentMeans.length;
    const enough = measured >= MIN_MEASURED;
    const value = enough ? round3(mean(studentMeans)) : null;

    return {
      classId: input.classId,
      className: input.className,
      subjectName: input.subjectName,
      academicYear: input.academicYear,
      students: input.studentIds.length,
      measured,
      meanEstimate: value,
      band: value === null ? null : bandFor(value),
      // Withheld alongside the mean rather than reported on its own: "2
      // struggling" over 2 measured students of 30 is not a fact about a
      // cohort, and printing it beside a refused mean would smuggle the number
      // back onto the page.
      struggling: enough
        ? studentMeans.filter((each) => each < STUDENT_THRESHOLD).length
        : null,
      comparable: enough,
      sentence:
        input.studentIds.length === 0
          ? "no students on the roster yet"
          : value === null
            ? `${measured} of ${input.studentIds.length} students have enough evidence — too few to compare`
            : `${pct(value)} across ${measured} of ${input.studentIds.length} students measured`,
    };
  });

  // Ordered by who needs somebody, not alphabetically — and a cohort nobody
  // can say anything about sorts above one that is fine, because "we do not
  // know about these thirty students" is more actionable than "these thirty
  // are doing well". The same rule the students index uses.
  const tier = (row: CohortRow) => {
    if (row.students === 0) return 3;
    if (row.meanEstimate === null) return 1;
    return row.meanEstimate < STUDENT_THRESHOLD ? 0 : 2;
  };

  return rows.sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (a.meanEstimate !== null && b.meanEstimate !== null) {
      if (a.meanEstimate !== b.meanEstimate) return a.meanEstimate - b.meanEstimate;
    }
    return a.className.localeCompare(b.className);
  });
}

export type CohortSpread = {
  /** Cohorts with enough measured students to be compared at all. */
  comparable: number;
  /** Cohorts on the roster, comparable or not. The denominator. */
  total: number;
  strongest: CohortRow | null;
  weakest: CohortRow | null;
  /** In mastery points, or null when there is nothing to compare. */
  gapPoints: number | null;
  sentence: string;
};

/**
 * The distance between the strongest and the weakest comparable cohort.
 *
 * Reported as a distance between two NAMED cohorts with both denominators
 * attached, never as a league table and never as a spread over an average
 * nobody can locate. An owner reading "19 points apart" has one question next —
 * *which two* — and a figure that cannot answer it is a figure that starts an
 * argument instead of a conversation.
 */
export function cohortSpread(rows: CohortRow[]): CohortSpread {
  const comparable = rows.filter(
    (row): row is CohortRow & { meanEstimate: number } => row.meanEstimate !== null,
  );

  if (comparable.length < MIN_COMPARABLE_CLASSES) {
    return {
      comparable: comparable.length,
      total: rows.length,
      strongest: null,
      weakest: null,
      gapPoints: null,
      sentence:
        rows.length === 0
          ? "There are no classes to compare."
          : `${comparable.length} of ${rows.length} ${rows.length === 1 ? "class has" : "classes have"} enough measured students to be compared, and comparing needs at least ${MIN_COMPARABLE_CLASSES}.`,
    };
  }

  const ordered = [...comparable].sort((a, b) => a.meanEstimate - b.meanEstimate);
  const weakest = ordered[0]!;
  const strongest = ordered[ordered.length - 1]!;
  const gapPoints = Math.round((strongest.meanEstimate - weakest.meanEstimate) * 100);

  return {
    comparable: comparable.length,
    total: rows.length,
    strongest,
    weakest,
    gapPoints,
    sentence: `${weakest.className} and ${strongest.className} are ${gapPoints} points apart — ${weakest.sentence} against ${strongest.sentence}. ${comparable.length} of ${rows.length} classes have enough evidence to be in this comparison at all.`,
  };
}

/* ========================================================================== */
/* Concept weakness across the institute — pure                                */
/* ========================================================================== */

export type ConceptClassInput = {
  conceptId: string;
  conceptName: string;
  classId: string;
  className: string;
  /** One estimate per measured student in that class, on that concept. */
  estimates: number[];
  /** Students on that class's roster — the denominator for the cell. */
  enrolled: number;
};

export type ConceptClassCell = {
  classId: string;
  className: string;
  measured: number;
  enrolled: number;
  /** Null below MIN_MEASURED. A cell with no number is not a zero. */
  meanEstimate: number | null;
  band: Band | null;
  weak: boolean;
};

export type ConceptVerdict = "systemic" | "localised" | "steady" | "not-comparable";

export type ConceptSpreadRow = {
  conceptId: string;
  conceptName: string;
  /** Every class with any evidence on this concept, weakest first. */
  classes: ConceptClassCell[];
  /** Classes with enough evidence for a real number. The denominator. */
  comparable: number;
  weakClasses: number;
  /**
   * The mean of the comparable class means — one vote per class, not per
   * student. Null unless at least MIN_COMPARABLE_CLASSES have a number.
   */
  meanAcrossClasses: number | null;
  weakestClassId: string | null;
  verdict: ConceptVerdict;
  sentence: string;
  /** What to DO about it. Never "monitor". */
  action: string;
  href: string;
};

/**
 * The same concept, across every cohort — and the verdict that follows.
 *
 * ---------------------------------------------------------------------------
 * "Everywhere" and "one room" are different problems
 * ---------------------------------------------------------------------------
 * A concept below the line in one class, where the others are fine, is that
 * class: their teacher plans an intervention from the class gaps and the
 * product already measures whether it worked. The same concept below the line
 * in three of the four classes that have evidence is not three teaching
 * problems — it is the material, the order it sits in, or the time it is given,
 * and reteaching it in one room leaves the other two exactly where they were.
 *
 * An owner is the only person who can see both, because a teacher only ever
 * sees their own room. That is the whole reason this function exists.
 *
 * ---------------------------------------------------------------------------
 * One vote per class, and only classes that have a number
 * ---------------------------------------------------------------------------
 * `meanAcrossClasses` averages the class means, so a class of forty does not
 * drown a class of twelve — the question being asked is about rooms, not about
 * students. And a class below MIN_MEASURED contributes nothing in either
 * direction: it is not weak, it is not fine, it is unknown, and counting an
 * unknown as either is how a page invents its most confident finding.
 */
export function conceptSpread(inputs: ConceptClassInput[]): ConceptSpreadRow[] {
  const grouped = new Map<string, ConceptClassInput[]>();
  for (const input of inputs) {
    const list = grouped.get(input.conceptId) ?? [];
    list.push(input);
    grouped.set(input.conceptId, list);
  }

  const rows = [...grouped.values()].map((cells): ConceptSpreadRow => {
    const first = cells[0]!;

    const perClass = cells
      .map((cell): ConceptClassCell => {
        const measured = cell.estimates.length;
        const value = measured >= MIN_MEASURED ? round3(mean(cell.estimates)) : null;
        return {
          classId: cell.classId,
          className: cell.className,
          measured,
          enrolled: cell.enrolled,
          meanEstimate: value,
          band: value === null ? null : bandFor(value),
          weak: value !== null && value < STUDENT_THRESHOLD,
        };
      })
      // Weakest first, then the classes with no number. An owner reads the top
      // of a row and stops, so the top of the row has to be the reason it is
      // on the page.
      .sort((a, b) => {
        if (a.meanEstimate === null && b.meanEstimate === null) {
          return a.className.localeCompare(b.className);
        }
        if (a.meanEstimate === null) return 1;
        if (b.meanEstimate === null) return -1;
        return a.meanEstimate - b.meanEstimate;
      });

    const comparableCells = perClass.filter((cell) => cell.meanEstimate !== null);
    const weakCells = perClass.filter((cell) => cell.weak);
    const comparable = comparableCells.length;
    const weakClasses = weakCells.length;

    const verdict: ConceptVerdict =
      comparable < MIN_COMPARABLE_CLASSES
        ? "not-comparable"
        : weakClasses >= MIN_COMPARABLE_CLASSES
          ? "systemic"
          : weakClasses === 1
            ? "localised"
            : "steady";

    const weakest = weakCells[0] ?? null;
    const names = weakCells.map((cell) => cell.className).join(", ");

    const sentence =
      verdict === "systemic"
        ? `Below ${pct(STUDENT_THRESHOLD)} in ${weakClasses} of the ${comparable} classes with enough evidence: ${weakCells
            .map((cell) => `${cell.className} ${pct(cell.meanEstimate!)} over ${cell.measured} of ${cell.enrolled}`)
            .join("; ")}.`
        : verdict === "localised"
          ? `Below ${pct(STUDENT_THRESHOLD)} in ${names} alone (${pct(weakest!.meanEstimate!)} over ${weakest!.measured} of ${weakest!.enrolled}), of ${comparable} classes with enough evidence.`
          : verdict === "steady"
            ? `At or above ${pct(STUDENT_THRESHOLD)} in all ${comparable} classes with enough evidence.`
            : comparable === 0
              ? `No class has enough evidence on this yet — ${perClass.length} ${perClass.length === 1 ? "class has" : "classes have"} answered anything on it.`
              : `Only ${perClass[0]!.className} has enough evidence on this, so there is nothing to compare it with.`;

    const action =
      verdict === "systemic"
        ? `The same idea is below the line in more than one room, so it is more likely the material, the order it is taught in, or the time it is given than any one class. Look at how it is introduced across the institute — reteaching it in ${weakest!.className} alone leaves the others exactly where they are.`
        : verdict === "localised"
          ? `Only ${names} is behind on this and the other ${comparable - 1} ${comparable - 1 === 1 ? "class" : "classes"} with evidence are not, so this is that room rather than the syllabus. Open its gaps and plan an intervention there, which the product will then measure.`
          : verdict === "steady"
            ? "Nothing to do here."
            : `Set something covering this in the other classes — one class's figure is not a comparison, and until there are two this page can only tell you what you already knew.`;

    return {
      conceptId: first.conceptId,
      conceptName: first.conceptName,
      classes: perClass,
      comparable,
      weakClasses,
      meanAcrossClasses:
        comparable < MIN_COMPARABLE_CLASSES
          ? null
          : round3(mean(comparableCells.map((cell) => cell.meanEstimate!))),
      weakestClassId: weakest?.classId ?? perClass[0]?.classId ?? null,
      verdict,
      sentence,
      action,
      // Every insight ends somewhere it can be acted on. The class gaps page is
      // where an intervention is planned and, later, measured.
      href: weakest
        ? `/teacher/analytics/${weakest.classId}/gaps`
        : perClass[0]
          ? `/teacher/analytics/${perClass[0].classId}`
          : "/teacher/analytics",
    };
  });

  const order: Record<ConceptVerdict, number> = {
    systemic: 0,
    localised: 1,
    "not-comparable": 2,
    steady: 3,
  };

  return rows.sort((a, b) => {
    if (order[a.verdict] !== order[b.verdict]) {
      return order[a.verdict] - order[b.verdict];
    }
    if (a.weakClasses !== b.weakClasses) return b.weakClasses - a.weakClasses;
    const left = a.classes.find((cell) => cell.meanEstimate !== null)?.meanEstimate ?? 1;
    const right = b.classes.find((cell) => cell.meanEstimate !== null)?.meanEstimate ?? 1;
    if (left !== right) return left - right;
    return a.conceptName.localeCompare(b.conceptName);
  });
}

/* ========================================================================== */
/* Improvement, against stamped baselines — pure                               */
/* ========================================================================== */

export type OutcomeStamp = {
  interventionId: string;
  conceptId: string;
  conceptName: string;
  /** The cohort it was aimed at, when the gap was class-scope. */
  classId: string | null;
  className: string | null;
  kind: string;
  status: string;
  /** Stamped when the intervention was created. Never updated. */
  baselineMastery: number;
  baselineStudentCount: number;
  targetMastery: number;
  /** Null until measured. Null is not zero here either. */
  outcomeMastery: number | null;
  outcomeStudentCount: number | null;
  createdAt: Date;
  measuredAt: Date | null;
};

export type MeasuredOutcome = {
  interventionId: string;
  conceptName: string;
  className: string | null;
  kind: string;
  baselineMastery: number;
  baselineStudentCount: number;
  targetMastery: number;
  outcomeMastery: number;
  outcomeStudentCount: number;
  /** Outcome minus baseline. Negative is a real and useful result. */
  change: number;
  reachedTarget: boolean;
  baselineStampedAt: Date;
  measuredAt: Date;
  sentence: string;
  href: string;
};

export type Improvement = {
  /** Every measurement, each falsifiable on its own. Worst first. */
  measured: MeasuredOutcome[];
  /** Running, never measured, and old enough that it should have been. */
  unmeasured: {
    interventionId: string;
    conceptName: string;
    className: string | null;
    days: number;
    href: string;
  }[];
  claim:
    | {
        claimed: true;
        count: number;
        reached: number;
        /** Mean change in estimate across the measured interventions. */
        meanChange: number;
        sentence: string;
      }
    | {
        claimed: false;
        reason: "nothing-planned" | "nothing-measured" | "too-few-measured";
        sentence: string;
      };
};

/**
 * Whether anything has actually improved.
 *
 * ---------------------------------------------------------------------------
 * There is exactly one honest baseline, and it was written down first
 * ---------------------------------------------------------------------------
 * The tempting version of this function compares mastery now against mastery
 * three months ago, or reads `student_concept_mastery.previous_estimate` and
 * counts the arrows. Both are unfalsifiable in the same way: the comparison
 * point is whatever the number happened to be when somebody looked, it moves
 * every time anybody answers anything, and it always flatters whoever is
 * reporting it. An improvement claim nobody can check is the thing that
 * eventually loses the customer.
 *
 * `core/gaps/interventions.ts` already solved this: creation stamps the
 * baseline, the number of students behind it, and what would count as having
 * worked — all in one transaction, and nothing may change them afterwards.
 * This function reads those stamps and nothing else. If there are none, it says
 * so, and it does not reach for a substitute.
 *
 * ---------------------------------------------------------------------------
 * A measured failure is worth more than an unmeasured success
 * ---------------------------------------------------------------------------
 * So the failures are listed first, and the interventions nobody ever measured
 * are an exception on the page rather than a quiet absence. An intervention
 * left unmeasured is not a neutral outcome — it is a claim that was never
 * checked, and this is the surface where that has to be visible.
 */
export function improvementFromStamps(
  stamps: OutcomeStamp[],
  now = new Date(),
): Improvement {
  const hrefFor = (stamp: { classId: string | null }) =>
    stamp.classId ? `/teacher/analytics/${stamp.classId}/gaps` : "/teacher/analytics";

  const measured: MeasuredOutcome[] = stamps
    .flatMap((stamp) => {
      if (stamp.outcomeMastery === null || stamp.measuredAt === null) return [];
      const change = round3(stamp.outcomeMastery - stamp.baselineMastery);
      const where = stamp.className ? ` in ${stamp.className}` : "";
      return [
        {
          interventionId: stamp.interventionId,
          conceptName: stamp.conceptName,
          className: stamp.className,
          kind: stamp.kind,
          baselineMastery: stamp.baselineMastery,
          baselineStudentCount: stamp.baselineStudentCount,
          targetMastery: stamp.targetMastery,
          outcomeMastery: stamp.outcomeMastery,
          outcomeStudentCount: stamp.outcomeStudentCount ?? 0,
          change,
          reachedTarget: stamp.outcomeMastery >= stamp.targetMastery,
          baselineStampedAt: stamp.createdAt,
          measuredAt: stamp.measuredAt,
          // The whole claim in one sentence, with both denominators in it. A
          // figure an owner cannot locate is an assertion with a robot's
          // confidence.
          sentence: `${stamp.conceptName}${where}: ${pct(stamp.baselineMastery)} → ${pct(
            stamp.outcomeMastery,
          )} (${points(change)} points) against a baseline stamped before the teaching, over ${
            stamp.baselineStudentCount
          } students then and ${stamp.outcomeStudentCount ?? 0} at the measurement. The target was ${pct(
            stamp.targetMastery,
          )}.`,
          href: hrefFor(stamp),
        },
      ];
    })
    // Worst first. A measured failure says the thing that was tried did not
    // work, which is the single most useful line on this page.
    .sort((a, b) => a.change - b.change);

  const unmeasured = stamps
    .flatMap((stamp) => {
      if (stamp.measuredAt !== null) return [];
      if (stamp.status !== "PLANNED" && stamp.status !== "ACTIVE") return [];
      const days = Math.floor((now.getTime() - stamp.createdAt.getTime()) / DAY);
      if (days < INTERVENTION_STALE_DAYS) return [];
      return [
        {
          interventionId: stamp.interventionId,
          conceptName: stamp.conceptName,
          className: stamp.className,
          days,
          href: hrefFor(stamp),
        },
      ];
    })
    .sort((a, b) => b.days - a.days);

  const reached = measured.filter((row) => row.reachedTarget).length;

  if (stamps.length === 0) {
    return {
      measured,
      unmeasured,
      claim: {
        claimed: false,
        reason: "nothing-planned",
        sentence:
          "Nothing has been tried against a gap yet, so there is no improvement figure here — and there will not be one until an intervention is planned with a baseline stamped before the teaching, and then measured afterwards.",
      },
    };
  }

  if (measured.length === 0) {
    return {
      measured,
      unmeasured,
      claim: {
        claimed: false,
        reason: "nothing-measured",
        sentence: `${stamps.length} ${stamps.length === 1 ? "intervention has" : "interventions have"} been planned and none has been measured. Improvement needs both halves — a baseline stamped before the teaching and a measurement after it — so there is nothing to report yet.`,
      },
    };
  }

  if (measured.length < MIN_MEASURED_OUTCOMES) {
    return {
      measured,
      unmeasured,
      claim: {
        claimed: false,
        reason: "too-few-measured",
        sentence: `${measured.length} of ${stamps.length} interventions ${measured.length === 1 ? "has" : "have"} been measured — too few for a claim about the institute. Each measurement is a real result about the class it was aimed at and is listed in full below.`,
      },
    };
  }

  const meanChange = round3(mean(measured.map((row) => row.change)));

  return {
    measured,
    unmeasured,
    claim: {
      claimed: true,
      count: measured.length,
      reached,
      meanChange,
      sentence: `Across ${measured.length} measured interventions, mastery moved ${points(
        meanChange,
      )} points on average against baselines stamped before the teaching. ${reached} of ${
        measured.length
      } reached the target set when the work started.`,
    },
  };
}

/* ========================================================================== */
/* Exceptions — pure                                                           */
/* ========================================================================== */

export type InsightKind =
  | "concept-systemic"
  | "concept-localised"
  | "cohort-unmeasurable"
  | "intervention-unmeasured"
  | "intervention-missed";

export type Insight = {
  kind: InsightKind;
  severity: "high" | "medium";
  /** What it is about — a concept or a cohort, named. */
  subject: string;
  /** The finding, with the denominators it was computed over. */
  message: string;
  /** What to do about it. Every insight ends in one of these. */
  action: string;
  href: string;
};

/** How many of each kind reach the page before it becomes a wall. */
const MAX_SYSTEMIC = 4;
const MAX_LOCALISED = 2;
const MAX_UNMEASURABLE = 3;

/**
 * What an owner should do first, worst first.
 *
 * Exceptions before counts, the same shape `core/institute/kpis.ts` uses. An
 * owner does not need to be told the institute measured four hundred concepts;
 * they need the two ideas that are below the line in more than one room, and
 * the cohort nobody can say anything about yet.
 */
export function insightsFrom(input: {
  cohorts: CohortRow[];
  concepts: ConceptSpreadRow[];
  improvement: Improvement;
}): Insight[] {
  const found: Insight[] = [];

  // 1. A concept weak in more than one room. The most valuable line on the
  //    page, and the only one an owner is uniquely placed to act on.
  for (const concept of input.concepts.filter((row) => row.verdict === "systemic").slice(0, MAX_SYSTEMIC)) {
    found.push({
      kind: "concept-systemic",
      severity: "high",
      subject: concept.conceptName,
      message: concept.sentence,
      action: concept.action,
      href: concept.href,
    });
  }

  // 2. An intervention that was measured and missed. The product exists to
  //    produce this sentence, and burying it would waste the one measurement
  //    that was done honestly.
  const missed = input.improvement.measured.filter((row) => !row.reachedTarget);
  if (missed.length > 0) {
    const worst = missed[0]!;
    found.push({
      kind: "intervention-missed",
      severity: "high",
      subject: worst.className
        ? `${worst.conceptName} in ${worst.className}`
        : worst.conceptName,
      message:
        missed.length === 1
          ? `The reteaching did not reach its target. ${worst.sentence}`
          : `${missed.length} of ${input.improvement.measured.length} measured interventions missed the target they were given. The furthest short: ${worst.sentence}`,
      action:
        "What was tried did not move it, which is a result rather than a failure of the measurement — the gap will come back as PERSISTING at the next detection pass. Try a different approach before the next paper, and it will be measured the same way.",
      href: worst.href,
    });
  }

  // 3. A cohort nobody can say anything about. The refusal, turned into
  //    something to do: "1 of 30 measured" is a week's work away from being a
  //    real figure, and an owner is the person who can ask for the paper.
  for (const cohort of input.cohorts
    .filter((row) => row.students > 0 && row.meanEstimate === null)
    .slice(0, MAX_UNMEASURABLE)) {
    found.push({
      kind: "cohort-unmeasurable",
      severity: "medium",
      subject: cohort.className,
      message: `Nothing can be said about ${cohort.className} yet — ${cohort.sentence}. It is not that they are behind; it is that there is not enough marked work to know either way.`,
      action: `Have a paper set and marked for ${cohort.className}. Mastery needs at least ${MIN_MEASURED} measured students before this page will show a figure for a cohort, and it will keep refusing until then.`,
      href: `/teacher/classes/${cohort.classId}`,
    });
  }

  // 4. Something tried and never measured. An unmeasured intervention is an
  //    improvement claim nobody can check, which is exactly what this product
  //    is built not to produce.
  const stale = input.improvement.unmeasured;
  if (stale.length > 0) {
    const oldest = stale[0]!;
    found.push({
      kind: "intervention-unmeasured",
      severity: "medium",
      subject: "Unmeasured interventions",
      message:
        stale.length === 1
          ? `One intervention has been running for ${oldest.days} days without being measured (${oldest.conceptName}${oldest.className ? ` in ${oldest.className}` : ""}).`
          : `${stale.length} interventions have been running without being measured, the oldest for ${oldest.days} days.`,
      action:
        "Measure it. Until somebody does, whether the reteaching worked is an opinion — the baseline was stamped before it started and cannot be measured against retrospectively by anybody else.",
      href: oldest.href,
    });
  }

  // 5. A concept weak in one room alone. Lower down deliberately: it is a real
  //    finding, but it is the teacher's to act on and their own gaps page has
  //    already told them.
  for (const concept of input.concepts.filter((row) => row.verdict === "localised").slice(0, MAX_LOCALISED)) {
    found.push({
      kind: "concept-localised",
      severity: "medium",
      subject: concept.conceptName,
      message: concept.sentence,
      action: concept.action,
      href: concept.href,
    });
  }

  const order = { high: 0, medium: 1 } as const;
  // A stable sort, so two insights of the same severity keep the order above —
  // which is the order of how much only an owner can do about them.
  return found.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ========================================================================== */
/* The read                                                                    */
/* ========================================================================== */

export type InstituteAnalytics = {
  cohorts: CohortRow[];
  spread: CohortSpread;
  concepts: ConceptSpreadRow[];
  improvement: Improvement;
  insights: Insight[];
  /** Concepts with any evidence anywhere. The denominator for the list. */
  conceptsWithEvidence: number;
};

/**
 * Everything the institute analytics page needs, in one pass.
 *
 * The reads are here and the decisions are in the pure functions above, so the
 * rules that matter — when a figure exists, when it is refused, what counts as
 * systemic — can be tested without a database and argued with by reading them.
 *
 * Nothing in this function touches a teacher table. See the note at the top of
 * the file: there is no join here to add later.
 */
export async function instituteAnalytics(
  organizationId: string,
  now = new Date(),
): Promise<InstituteAnalytics> {
  const data = await withTenant(organizationId, async (tx) => {
    const classes = await tx.class.findMany({
      where: { deletedAt: null },
      include: { subject: { select: { name: true } } },
      orderBy: { name: "asc" },
    });

    const classIds = classes.map((klass) => klass.id);

    const enrolments =
      classIds.length === 0
        ? []
        : await tx.classEnrolment.findMany({
            where: { classId: { in: classIds }, status: "ACTIVE" },
            select: { classId: true, studentUserId: true },
          });

    const studentIds = [...new Set(enrolments.map((row) => row.studentUserId))];

    const mastery =
      studentIds.length === 0
        ? []
        : await tx.studentConceptMastery.findMany({
            where: { studentUserId: { in: studentIds }, estimate: { not: null } },
            select: { studentUserId: true, conceptId: true, estimate: true },
          });

    // The stamped baselines. Read whole rather than filtered to MEASURED,
    // because "planned and never measured" is a finding in its own right and
    // filtering it out here is how it would stop being one.
    const interventions = await tx.intervention.findMany({
      select: {
        id: true,
        learningGapId: true,
        kind: true,
        status: true,
        baselineMastery: true,
        baselineStudentCount: true,
        targetMastery: true,
        outcomeMastery: true,
        outcomeStudentCount: true,
        createdAt: true,
        measuredAt: true,
      },
    });

    const gaps =
      interventions.length === 0
        ? []
        : await tx.learningGap.findMany({
            where: { id: { in: interventions.map((row) => row.learningGapId) } },
            select: { id: true, conceptId: true, scope: true, scopeId: true },
          });

    return { classes, enrolments, mastery, interventions, gaps };
  });

  const { classes, enrolments, mastery, interventions, gaps } = data;

  const classNameById = new Map(classes.map((klass) => [klass.id, klass.name]));

  const studentsByClass = new Map<string, string[]>();
  for (const enrolment of enrolments) {
    const list = studentsByClass.get(enrolment.classId) ?? [];
    list.push(enrolment.studentUserId);
    studentsByClass.set(enrolment.classId, list);
  }

  const readingsByStudent = new Map<string, { conceptId: string; estimate: number }[]>();
  for (const row of mastery) {
    const list = readingsByStudent.get(row.studentUserId) ?? [];
    list.push({ conceptId: row.conceptId, estimate: Number(row.estimate) });
    readingsByStudent.set(row.studentUserId, list);
  }

  const cohortInputs: CohortInput[] = classes.map((klass) => {
    const students = studentsByClass.get(klass.id) ?? [];
    return {
      classId: klass.id,
      className: klass.name,
      subjectName: klass.subject.name,
      academicYear: klass.academicYear,
      studentIds: students,
      readings: students.flatMap((studentId) =>
        (readingsByStudent.get(studentId) ?? []).map((reading) => ({
          studentUserId: studentId,
          estimate: reading.estimate,
        })),
      ),
    };
  });

  // concept -> class -> the estimates of that class's measured students.
  // A student enrolled in two classes contributes to both, which is correct:
  // they sit in both rooms.
  const grid = new Map<string, Map<string, number[]>>();
  for (const [classId, students] of studentsByClass) {
    for (const studentId of students) {
      for (const reading of readingsByStudent.get(studentId) ?? []) {
        const byClass = grid.get(reading.conceptId) ?? new Map<string, number[]>();
        const values = byClass.get(classId) ?? [];
        values.push(reading.estimate);
        byClass.set(classId, values);
        grid.set(reading.conceptId, byClass);
      }
    }
  }

  const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
  const conceptIds = [
    ...new Set([...grid.keys(), ...gaps.map((gap) => gap.conceptId)]),
  ];
  const context = await conceptContext(conceptIds);
  const conceptName = (id: string) => context.get(id)?.name ?? "A concept";

  const conceptInputs: ConceptClassInput[] = [];
  for (const [conceptId, byClass] of grid) {
    for (const [classId, estimates] of byClass) {
      conceptInputs.push({
        conceptId,
        conceptName: conceptName(conceptId),
        classId,
        className: classNameById.get(classId) ?? "A class",
        estimates,
        enrolled: (studentsByClass.get(classId) ?? []).length,
      });
    }
  }

  const stamps: OutcomeStamp[] = interventions.map((row) => {
    const gap = gapById.get(row.learningGapId);
    const classId =
      gap && gap.scope === "CLASS" && classNameById.has(gap.scopeId) ? gap.scopeId : null;
    return {
      interventionId: row.id,
      conceptId: gap?.conceptId ?? "",
      conceptName: gap ? conceptName(gap.conceptId) : "A concept",
      classId,
      className: classId === null ? null : (classNameById.get(classId) ?? null),
      kind: row.kind,
      status: row.status,
      baselineMastery: Number(row.baselineMastery),
      baselineStudentCount: row.baselineStudentCount,
      targetMastery: Number(row.targetMastery),
      outcomeMastery: row.outcomeMastery === null ? null : Number(row.outcomeMastery),
      outcomeStudentCount: row.outcomeStudentCount,
      createdAt: row.createdAt,
      measuredAt: row.measuredAt,
    };
  });

  const cohorts = cohortRows(cohortInputs);
  const concepts = conceptSpread(conceptInputs);
  const improvement = improvementFromStamps(stamps, now);

  return {
    cohorts,
    spread: cohortSpread(cohorts),
    concepts,
    improvement,
    insights: insightsFrom({ cohorts, concepts, improvement }),
    conceptsWithEvidence: grid.size,
  };
}
