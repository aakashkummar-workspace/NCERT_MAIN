/**
 * The assignment window.
 *
 * ---------------------------------------------------------------------------
 * Why status is derived and not stored
 * ---------------------------------------------------------------------------
 * Whether an assignment is scheduled, open or closed is a function of two
 * timestamps and the current time. Storing it as a column would mean a
 * scheduled job flipping rows — and between ticks, a row whose status is a
 * lie. A student would be told a test is closed while the window is open, or
 * worse, the reverse.
 *
 * Derived at read time it cannot drift, needs no cron, and is the same answer
 * on every server. `cancelledAt` is stored because it is the one piece of state
 * a clock cannot produce.
 *
 * This is the same rule as the exam clock: compute from stamps, never
 * accumulate or cache.
 *
 * Pure — no database, no `server-only` — so the badge a teacher sees in the
 * browser and the check the server makes before letting a student start are
 * the same function.
 */

export type AssignmentStatus =
  | "SCHEDULED"
  | "OPEN"
  | "CLOSED"
  | "CANCELLED";

export type Window = {
  opensAt: Date;
  closesAt: Date;
  cancelledAt?: Date | null;
};

export function assignmentStatus(window: Window, now = new Date()): AssignmentStatus {
  if (window.cancelledAt) return "CANCELLED";
  if (now < window.opensAt) return "SCHEDULED";
  if (now >= window.closesAt) return "CLOSED";
  return "OPEN";
}

/** Can a student begin a new attempt right now? */
export function canStart(window: Window, now = new Date()): boolean {
  return assignmentStatus(window, now) === "OPEN";
}

export type WindowProblem = {
  field: "opensAt" | "closesAt" | "duration" | "maxAttempts";
  message: string;
};

export function validateWindow(input: {
  opensAt: Date;
  closesAt: Date;
  durationMinutes: number;
  durationOverrideMinutes?: number | null;
  maxAttempts: number;
  now?: Date;
}): WindowProblem[] {
  const problems: WindowProblem[] = [];
  const now = input.now ?? new Date();

  if (Number.isNaN(input.opensAt.getTime())) {
    problems.push({ field: "opensAt", message: "That opening time is not a date." });
  }
  if (Number.isNaN(input.closesAt.getTime())) {
    problems.push({ field: "closesAt", message: "That closing time is not a date." });
  }
  if (problems.length > 0) return problems;

  if (input.closesAt <= input.opensAt) {
    problems.push({
      field: "closesAt",
      message: "The window has to close after it opens.",
    });
    return problems;
  }

  const effectiveDuration =
    input.durationOverrideMinutes ?? input.durationMinutes;
  const windowMinutes =
    (input.closesAt.getTime() - input.opensAt.getTime()) / 60000;

  if (windowMinutes < effectiveDuration) {
    // The failure that hands a class a test they cannot finish.
    problems.push({
      field: "closesAt",
      message: `The window is ${Math.round(windowMinutes)} minutes long but the test takes ${effectiveDuration}. Nobody could finish it.`,
    });
  }

  // A window that closed before it was created is almost certainly a typo, and
  // it is unrecoverable for a student: they never get to sit it.
  if (input.closesAt <= now) {
    problems.push({
      field: "closesAt",
      message: "That window has already closed. Nobody would be able to take it.",
    });
  }

  if (input.durationOverrideMinutes !== null &&
      input.durationOverrideMinutes !== undefined) {
    if (input.durationOverrideMinutes < 5 || input.durationOverrideMinutes > 360) {
      problems.push({
        field: "duration",
        message: "A sitting runs between 5 and 360 minutes.",
      });
    }
  }

  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    problems.push({
      field: "maxAttempts",
      message: "Allow at least one attempt.",
    });
  } else if (input.maxAttempts > 5) {
    problems.push({
      field: "maxAttempts",
      message: "More than five attempts is practice, not an assessment.",
    });
  }

  return problems;
}

/**
 * A window a teacher will usually accept without editing: opens now, closes
 * tomorrow evening, comfortably longer than the paper.
 */
export function suggestWindow(
  durationMinutes: number,
  now = new Date(),
): { opensAt: Date; closesAt: Date } {
  const opensAt = new Date(now.getTime() + 5 * 60_000);
  const closesAt = new Date(opensAt);
  closesAt.setDate(closesAt.getDate() + 1);
  // Ends at 20:00 IST, which is after evening tuition and before it is unfair
  // to expect a school student to be awake.
  closesAt.setUTCHours(14, 30, 0, 0);

  // If that lands before the paper could be finished, push it a day.
  if ((closesAt.getTime() - opensAt.getTime()) / 60000 < durationMinutes + 60) {
    closesAt.setDate(closesAt.getDate() + 1);
  }

  return { opensAt, closesAt };
}

/**
 * How the window reads to a person. Deliberately relative near the boundaries,
 * because "closes in 40 minutes" is what a teacher needs during a sitting and
 * a timestamp is not.
 */
export function describeWindow(window: Window, now = new Date()): string {
  const status = assignmentStatus(window, now);

  if (status === "CANCELLED") return "Cancelled";

  if (status === "SCHEDULED") {
    const minutes = Math.round((window.opensAt.getTime() - now.getTime()) / 60000);
    if (minutes < 60) return `Opens in ${minutes} ${plural(minutes, "minute")}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Opens in ${hours} ${plural(hours, "hour")}`;
    const days = Math.round(hours / 24);
    return `Opens in ${days} ${plural(days, "day")}`;
  }

  if (status === "OPEN") {
    const minutes = Math.round((window.closesAt.getTime() - now.getTime()) / 60000);
    if (minutes < 60) return `Closes in ${minutes} ${plural(minutes, "minute")}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Closes in ${hours} ${plural(hours, "hour")}`;
    const days = Math.round(hours / 24);
    return `Closes in ${days} ${plural(days, "day")}`;
  }

  return "Closed";
}

function plural(count: number, word: string) {
  return count === 1 ? word : `${word}s`;
}

/**
 * Whether the score is showing yet.
 *
 * One function, because the rule has to mean the same thing in three places:
 * the student's list of tests, their own result page, and — since the parent
 * portal — what a parent can see. It was written out twice before this existed,
 * and a parent seeing a mark before their child does turns a result into an
 * ambush, so a third copy was not an option.
 *
 * Note this is `visible`, the weaker gate. The answer KEY needs the window
 * closed as well; see `studentResult`.
 */
export function resultsVisible(
  assignment: {
    resultsPolicy: "IMMEDIATE" | "AFTER_CLOSE" | "MANUAL";
    closesAt: Date;
    resultsReleasedAt: Date | null;
  },
  now = new Date(),
): boolean {
  switch (assignment.resultsPolicy) {
    case "IMMEDIATE":
      return true;
    case "AFTER_CLOSE":
      return now >= assignment.closesAt;
    case "MANUAL":
      return assignment.resultsReleasedAt !== null;
  }
}
