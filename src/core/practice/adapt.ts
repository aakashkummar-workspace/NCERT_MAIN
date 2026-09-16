/**
 * How hard the next practice question should be.
 *
 * Pure, and separate from the session machinery, because this is the rule that
 * decides whether a student's evening is useful or demoralising — and it has to
 * be arguable without reading a query.
 *
 * ---------------------------------------------------------------------------
 * Two in a row, not one
 * ---------------------------------------------------------------------------
 * Stepping on a single answer makes the set oscillate: right, harder, wrong,
 * easier, right, harder. A student gets a sawtooth instead of a direction, and
 * on a four-question set they never settle anywhere.
 *
 * Two consecutive is the smallest signal that is not noise. On a set of six to
 * ten it produces at most a couple of steps, which is the right amount of
 * movement for a sitting that long.
 *
 * ---------------------------------------------------------------------------
 * It steps down faster than it steps up
 * ---------------------------------------------------------------------------
 * Not symmetric, deliberately. A student getting things wrong is the case where
 * staying put costs the most: they are already behind — that is why the set was
 * recommended — and a run of questions they cannot do is how somebody decides
 * they are bad at the subject and closes the tab. Two wrong drops a level. Two
 * right raises one, but never above the level the set was calibrated for plus
 * one, because the point of the session is the concept, not a ladder.
 */

export type Difficulty = "EASY" | "MEDIUM" | "HARD";

const ORDER: Difficulty[] = ["EASY", "MEDIUM", "HARD"];

/** Consecutive answers in one direction before the level moves. */
export const RUN_TO_STEP = 2;

export type Verdict = { correct: boolean; difficulty: Difficulty };

export type Adaptation = {
  next: Difficulty;
  /** Why, in a sentence — the runner shows it so the change is not mysterious. */
  reason: "start" | "harder" | "easier" | "steady";
};

function indexOf(difficulty: Difficulty): number {
  const index = ORDER.indexOf(difficulty);
  return index === -1 ? 1 : index;
}

/**
 * The level for the next question.
 *
 * `base` is where the set started — derived from how far behind the student is,
 * by `calibrate()` in the remedial builder. It is the floor's reference point:
 * a student who was started on EASY because they are at 0.3 does not get taken
 * to HARD by two lucky answers.
 */
export function nextDifficulty(
  base: Difficulty,
  history: Verdict[],
): Adaptation {
  if (history.length === 0) return { next: base, reason: "start" };

  const current = history[history.length - 1]!.difficulty;
  const tail = history.slice(-RUN_TO_STEP);

  const allRight = tail.length === RUN_TO_STEP && tail.every((v) => v.correct);
  const allWrong = tail.length === RUN_TO_STEP && tail.every((v) => !v.correct);

  if (allWrong) {
    // Down, and no floor beyond EASY. A run they cannot do is how somebody
    // decides they are bad at the subject and stops.
    const next = ORDER[Math.max(0, indexOf(current) - 1)]!;
    return { next, reason: next === current ? "steady" : "easier" };
  }

  if (allRight) {
    // Up, but capped one above where the set started. The session is about the
    // concept, not about climbing a ladder — and a student put on EASY because
    // they are at 0.3 has not earned HARD with two answers.
    const ceiling = Math.min(ORDER.length - 1, indexOf(base) + 1);
    const next = ORDER[Math.min(ceiling, indexOf(current) + 1)]!;
    return { next, reason: next === current ? "steady" : "harder" };
  }

  return { next: current, reason: "steady" };
}

/**
 * Pick from what the bank actually holds.
 *
 * The wanted level is a preference, not a requirement: a concept with no HARD
 * questions must still serve a next question rather than ending the set early.
 * Nearest level wins, and ties break downward — an unavailable HARD becomes
 * MEDIUM rather than nothing.
 */
export function pickNearest<T extends { difficulty: Difficulty }>(
  wanted: Difficulty,
  available: T[],
): T | null {
  if (available.length === 0) return null;

  const target = indexOf(wanted);
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of available) {
    const distance = Math.abs(indexOf(candidate.difficulty) - target);
    const isCloser = distance < bestDistance;
    // A tie goes to the easier one. Serving a student a harder question than
    // asked for, because the bank happened to be short, is the one direction
    // this must not drift in.
    const isEasierTie =
      distance === bestDistance &&
      best !== null &&
      indexOf(candidate.difficulty) < indexOf(best.difficulty);

    if (isCloser || isEasierTie) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}
