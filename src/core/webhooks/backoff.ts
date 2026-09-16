/**
 * When to try again.
 *
 * ---------------------------------------------------------------------------
 * Exponential, because the two failures look identical from here
 * ---------------------------------------------------------------------------
 * A school's server being down for four seconds and being down for four days
 * produce the same 502 on the first attempt. A fixed interval serves the first
 * case badly (too slow) or the second case very badly indeed: retrying every
 * thirty seconds for four days is roughly eleven thousand requests at a server
 * that is already unwell, from a product whose job was to send it three.
 *
 * So the interval grows: a minute, then five, then twenty-five, then two hours,
 * capped at six. Five attempts spread over most of a working day, which is long
 * enough to survive a lunchtime reboot and short enough that a real outage is
 * DEAD — and therefore visible on the console — before the office goes home.
 *
 * ---------------------------------------------------------------------------
 * Jitter, and why it is a parameter
 * ---------------------------------------------------------------------------
 * Every delivery to one school fails at the same moment for the same reason:
 * their server is down. Without jitter all of them retry in the same second,
 * forever, in a tightening group — the classic thundering herd, aimed at the
 * machine least able to take it.
 *
 * The randomness is passed in rather than reached for, so this function stays
 * pure and the schedule is a thing a test can assert exactly rather than
 * approximately.
 */

/** Section 9's default, restated here so the two cannot drift apart silently. */
export const MAX_ATTEMPTS = 5;

const BASE_MS = 60_000;
const FACTOR = 5;
const CAP_MS = 6 * 60 * 60 * 1000;

/** Up to this fraction of the delay is added, never subtracted. */
const JITTER = 0.2;

/**
 * The delay before attempt number `attemptsSoFar + 1`.
 *
 * `attemptsSoFar` is the value already stored on the job — 1 after the first
 * try — so `nextDelayMs(1)` is the wait before the second.
 *
 * `rand` is a number in [0, 1). Pass a constant in tests.
 */
export function nextDelayMs(attemptsSoFar: number, rand = Math.random()): number {
  const step = Math.max(0, attemptsSoFar - 1);
  const base = Math.min(BASE_MS * Math.pow(FACTOR, step), CAP_MS);
  return Math.round(base * (1 + JITTER * rand));
}

export function nextRunAt(
  attemptsSoFar: number,
  now: Date,
  rand = Math.random(),
): Date {
  return new Date(now.getTime() + nextDelayMs(attemptsSoFar, rand));
}

/** True when this failure was the last one the job gets. */
export function isExhausted(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}
