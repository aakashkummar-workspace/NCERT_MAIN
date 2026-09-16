/**
 * What counts as a gap, and how serious it is.
 *
 * Pure, because this is the function that decides what a teacher is told to
 * reteach on Monday. It has to be arguable — a teacher who disagrees with a
 * finding should be able to be shown the rule, not a black box.
 *
 * ---------------------------------------------------------------------------
 * A gap is not a low score
 * ---------------------------------------------------------------------------
 * It is a concept below threshold **with enough evidence to say so**. That
 * second half is the whole difference. A class that scored badly on a paper
 * nobody has finished marking is not a class with a gap; it is a class with a
 * marking backlog, and telling a teacher to reteach on that basis wastes a
 * lesson and their trust at the same time.
 *
 * So every threshold here operates on students who already have a real
 * estimate. `core/mastery` refuses to produce one below its evidence bar, and
 * a student it refused for is simply not counted — neither as struggling nor as
 * fine.
 */

export type Band = "CRITICAL" | "FRAGILE" | "DEVELOPING" | "SECURE" | "INSUFFICIENT";
export type Severity = "HIGH" | "MEDIUM" | "LOW";

/**
 * Below this, a concept is a gap for that student.
 *
 * 0.6 is the DEVELOPING floor from the mastery scale — "almost there" is the
 * first band the product is willing to call adequate. Using the same boundary
 * the colours use means a teacher looking at an amber bar and a gap list is
 * reading one fact, not two that nearly agree.
 */
export const STUDENT_THRESHOLD = 0.6;

/**
 * A class-scope gap needs this fraction of the MEASURED students below the
 * line. A third: enough that reteaching to the room is the right call rather
 * than sitting with two students at lunch.
 */
export const CLASS_FRACTION = 1 / 3;

/**
 * And at least this many students, however small the class.
 *
 * Two students below threshold in a class of five is 40% and still two
 * students. The fraction alone would put a whole lesson on the timetable for
 * them, when the honest answer is a conversation.
 */
export const CLASS_MINIMUM = 3;

/** And enough measured students for the fraction to mean anything at all. */
export const MIN_MEASURED = 3;

export type StudentReading = {
  studentUserId: string;
  /** Null whenever the band is INSUFFICIENT — such a student is not counted. */
  estimate: number | null;
  band: Band;
};

export function isStudentGap(reading: StudentReading): boolean {
  return reading.estimate !== null && reading.estimate < STUDENT_THRESHOLD;
}

/**
 * How serious a gap is for one student.
 *
 * CRITICAL means they cannot do it at all; FRAGILE means they can sometimes.
 * Those need different lessons, so they get different severities rather than
 * one "below threshold" bucket that flattens the difference.
 */
export function studentSeverity(estimate: number): Severity {
  if (estimate < 0.4) return "HIGH";
  if (estimate < 0.5) return "MEDIUM";
  return "LOW";
}

export type ClassVerdict =
  | { gap: false; measured: number; struggling: number; reason: "too-few-measured" | "enough-doing-well" }
  | {
      gap: true;
      measured: number;
      struggling: number;
      severity: Severity;
      meanEstimate: number;
    };

/**
 * Whether a concept is a gap for a whole class.
 *
 * Reports the denominator either way, because "3 of 4 measured" and "3 of 30
 * measured" are different findings and only one of them is about the class.
 */
export function classVerdict(readings: StudentReading[]): ClassVerdict {
  const measured = readings.filter((reading) => reading.estimate !== null);
  if (measured.length < MIN_MEASURED) {
    return { gap: false, measured: measured.length, struggling: 0, reason: "too-few-measured" };
  }

  const struggling = measured.filter(isStudentGap);
  const enough =
    struggling.length >= CLASS_MINIMUM &&
    struggling.length / measured.length >= CLASS_FRACTION;

  if (!enough) {
    return {
      gap: false,
      measured: measured.length,
      struggling: struggling.length,
      reason: "enough-doing-well",
    };
  }

  // The mean over the STRUGGLING students, not the class. A gap's severity is
  // about how far behind the students who are behind are; averaging in the
  // ones who are fine would make a class with a few very weak students look
  // like a class with a mild problem.
  const mean =
    struggling.reduce((sum, reading) => sum + (reading.estimate ?? 0), 0) /
    struggling.length;

  const share = struggling.length / measured.length;
  const severity: Severity =
    mean < 0.4 || share >= 0.6 ? "HIGH" : mean < 0.5 || share >= 0.45 ? "MEDIUM" : "LOW";

  return {
    gap: true,
    measured: measured.length,
    struggling: struggling.length,
    severity,
    meanEstimate: Math.round(mean * 1000) / 1000,
  };
}

/**
 * Which prerequisite to blame, if any.
 *
 * A concept is only a root cause when the group is weak on IT as well. A
 * prerequisite everybody has already mastered is not why they are stuck, and
 * naming it would send a teacher to reteach something the class can do — which
 * is worse than saying nothing, because it costs a lesson and looks confident.
 *
 * The weakest qualifying prerequisite wins: if two foundations are shaky, the
 * shakier one is where Monday starts.
 */
export function rootCause(
  prerequisites: { conceptId: string; meanEstimate: number | null }[],
): string | null {
  const weak = prerequisites.filter(
    (prerequisite) =>
      prerequisite.meanEstimate !== null &&
      prerequisite.meanEstimate < STUDENT_THRESHOLD,
  );
  if (weak.length === 0) return null;

  return weak.reduce((worst, candidate) =>
    (candidate.meanEstimate ?? 1) < (worst.meanEstimate ?? 1) ? candidate : worst,
  ).conceptId;
}

export type Transition =
  | {
      status: "DETECTED" | "ACKNOWLEDGED" | "INTERVENING" | "PERSISTING";
      resolved: false;
    }
  | { status: "RESOLVED"; resolved: true };

/**
 * Where the most recent intervention on a gap stands.
 *
 *   NONE    — nothing has been tried
 *   OPEN    — something is in progress and has not been measured
 *   MET     — measured, and it reached its target
 *   MISSED  — measured, and it did not
 */
export type InterventionState = "NONE" | "OPEN" | "MET" | "MISSED";

/**
 * What a re-detection does to a gap that already exists.
 *
 * The invariant this protects: **a gap resolves only on new evidence.** Never
 * on the passage of time, and never on a teacher marking it done. A product
 * where a gap can be dismissed is a product whose dashboard measures how tidy
 * the teacher is.
 *
 * PERSISTING means "what was tried did not work", and that is a claim only a
 * MEASUREMENT can make. It used to be set whenever a gap with an intervention
 * open was seen again — and detection runs on every submission and every saved
 * mark, so a gap flipped to "still there after an intervention" minutes after a
 * teacher recorded a lesson they had not yet taught, the first time any student
 * in the school handed in any paper. The most important signal in the product
 * was being produced by a timing accident, and a signal that fires on the day
 * of the lesson teaches a teacher to ignore it.
 *
 * So: an open intervention keeps the gap INTERVENING until somebody measures
 * it; a measured miss on a gap that is still there is PERSISTING; and a
 * measured success on a gap that is somehow still there says the target was
 * reached but the class line was not — seen, not failed, so ACKNOWLEDGED.
 */
export function transitionFor(
  previousStatus: string | null,
  stillBelowThreshold: boolean,
  intervention: InterventionState = "NONE",
): Transition {
  if (!stillBelowThreshold) return { status: "RESOLVED", resolved: true };
  if (intervention === "OPEN") return { status: "INTERVENING", resolved: false };
  if (intervention === "MISSED") return { status: "PERSISTING", resolved: false };
  // ACKNOWLEDGED survives a re-detection. Somebody has already seen this one,
  // and moving it back to DETECTED would put it in front of them again as
  // though it were new — which is how a list of findings becomes noise. A gap
  // somebody has worked on has been seen too, whatever its status says now.
  if (
    intervention === "MET" ||
    previousStatus === "ACKNOWLEDGED" ||
    previousStatus === "INTERVENING" ||
    previousStatus === "PERSISTING"
  ) {
    return { status: "ACKNOWLEDGED", resolved: false };
  }
  return { status: "DETECTED", resolved: false };
}

/**
 * The state of the most recent intervention, from its row.
 *
 * Pure, so detection and the tests read the same rule. Rows are expected
 * newest first; only the first matters, because an older measured attempt is
 * history and the question is what is true of the latest one.
 */
export function interventionStateOf(
  rows: { status: string; outcomeMastery: number | null; targetMastery: number }[],
): InterventionState {
  const latest = rows[0];
  if (!latest) return "NONE";
  if (latest.status !== "MEASURED" || latest.outcomeMastery === null) {
    return latest.status === "PLANNED" || latest.status === "ACTIVE" ? "OPEN" : "NONE";
  }
  return latest.outcomeMastery >= latest.targetMastery ? "MET" : "MISSED";
}
