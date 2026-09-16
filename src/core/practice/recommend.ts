/**
 * What to practise next, and why.
 *
 * Pure. Same reason the mastery estimator and the gap rules are: this is the
 * function that decides what a fifteen-year-old spends their evening on, and a
 * student who disagrees with it should be able to be shown the rule.
 *
 * ---------------------------------------------------------------------------
 * Deterministic candidates, human-readable reasons
 * ---------------------------------------------------------------------------
 * ARCHITECTURE.md specifies a deterministic candidate set with AI only ever
 * ordering it, and `recommendations.rationale` is annotated *always
 * human-readable* in the schema. Both point the same way: a recommendation a
 * student cannot interrogate is a recommendation they stop trusting the first
 * time it is wrong. So every candidate here carries the sentence that justifies
 * it, and the sentence is built from the numbers that produced it.
 *
 * ---------------------------------------------------------------------------
 * It refuses
 * ---------------------------------------------------------------------------
 * With nothing measured there is no recommendation — not a default, not "revise
 * everything". The fifth application of the refusal pattern in this codebase,
 * and the reasoning is identical: a confident suggestion built on no evidence
 * spends a student's evening on a guess.
 */

export type Band = "CRITICAL" | "FRAGILE" | "DEVELOPING" | "SECURE" | "INSUFFICIENT";

export type ConceptState = {
  conceptId: string;
  conceptName: string;
  /** Null whenever the band is INSUFFICIENT. Never treated as zero. */
  estimate: number | null;
  band: Band;
  /** Open mistakes the student has on this concept. */
  openMistakes: number;
  /** When they last produced evidence on it. Null if never. */
  lastEvidenceAt: Date | null;
  /** Approved, machine-markable questions available to practise. */
  available: number;
};

export type Reason =
  | "mistakes"
  | "weakest"
  | "fragile"
  | "going-stale"
  | "keep-sharp";

export type Candidate = {
  conceptId: string;
  conceptName: string;
  reason: Reason;
  /** Lower sorts first. Not shown; the sentence is what a student reads. */
  priority: number;
  /** One sentence, addressed to the student, built from the numbers above. */
  rationale: string;
  /** How many questions this set should hold. */
  questionCount: number;
  estimate: number | null;
  openMistakes: number;
};

/** Below this a concept is worth practising. The same 0.6 as everywhere else. */
export const PRACTICE_THRESHOLD = 0.6;

/** Above this it is secure, and practice is maintenance rather than repair. */
export const SECURE_THRESHOLD = 0.8;

/** Evidence older than this has decayed enough to be worth refreshing. */
export const STALE_DAYS = 45;

/** Fewer than this and a set cannot tell you anything. Same floor as remedial. */
export const MIN_SET = 4;

/** More than this and it stops being practice and becomes an exam. */
export const MAX_SET = 10;

/**
 * How long a set should be, given how far behind they are.
 *
 * Longer for a weak concept, because that is where the repetitions are worth
 * something — and short for a secure one, because ten questions on something
 * you can already do is how a student learns that practice is a waste of time.
 */
function sizeFor(estimate: number | null, openMistakes: number): number {
  if (estimate === null) return MIN_SET;
  if (estimate < 0.4) return 8;
  if (estimate < PRACTICE_THRESHOLD) return 6;
  if (openMistakes > 0) return MIN_SET;
  return MIN_SET;
}

function daysSince(date: Date | null, now: Date): number | null {
  if (date === null) return null;
  return (now.getTime() - date.getTime()) / 86_400_000;
}

/**
 * The candidate set, best first.
 *
 * A concept appears at most once, under its strongest reason — a student with
 * two open mistakes on a concept they are also weak at does not need two cards
 * telling them the same thing.
 */
export function recommend(
  states: ConceptState[],
  now = new Date(),
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const state of states) {
    // Nothing to serve. A recommendation that opens an empty set is worse than
    // no recommendation, because the student has already spent the tap.
    if (state.available < MIN_SET) continue;

    const size = Math.min(
      MAX_SET,
      Math.max(MIN_SET, Math.min(sizeFor(state.estimate, state.openMistakes), state.available)),
    );
    const stale = daysSince(state.lastEvidenceAt, now);

    // 1. Questions they have already got wrong and not yet fixed. The most
    //    specific thing the product knows about this student.
    if (state.openMistakes > 0) {
      candidates.push({
        conceptId: state.conceptId,
        conceptName: state.conceptName,
        reason: "mistakes",
        priority: 0,
        rationale:
          state.openMistakes === 1
            ? `You have one question on ${state.conceptName} you got wrong and have not fixed yet.`
            : `You have ${state.openMistakes} questions on ${state.conceptName} you got wrong and have not fixed yet.`,
        questionCount: size,
        estimate: state.estimate,
        openMistakes: state.openMistakes,
      });
      continue;
    }

    // 2. Measured below the line. The number is in the sentence, because "you
    //    are weak at this" is an accusation and "you are getting about a third
    //    of these right" is a fact.
    if (state.estimate !== null && state.estimate < 0.4) {
      candidates.push({
        conceptId: state.conceptId,
        conceptName: state.conceptName,
        reason: "weakest",
        priority: 1,
        rationale: `You are getting about ${Math.round(state.estimate * 100)}% of ${state.conceptName} questions right. This is the one to work on.`,
        questionCount: size,
        estimate: state.estimate,
        openMistakes: 0,
      });
      continue;
    }

    if (state.estimate !== null && state.estimate < PRACTICE_THRESHOLD) {
      candidates.push({
        conceptId: state.conceptId,
        conceptName: state.conceptName,
        reason: "fragile",
        priority: 2,
        rationale: `You can do ${state.conceptName} some of the time — about ${Math.round(state.estimate * 100)}%. A few more should settle it.`,
        questionCount: size,
        estimate: state.estimate,
        openMistakes: 0,
      });
      continue;
    }

    // 3. Decaying. The estimator forgets on purpose, so a concept nobody has
    //    touched since August is one the product is steadily less sure about —
    //    and that uncertainty is a real reason to practise, not a bug.
    if (state.estimate !== null && stale !== null && stale > STALE_DAYS) {
      candidates.push({
        conceptId: state.conceptId,
        conceptName: state.conceptName,
        reason: "going-stale",
        priority: 3,
        rationale: `You have not done any ${state.conceptName} for about ${Math.round(stale / 7)} weeks. Worth a quick check.`,
        questionCount: MIN_SET,
        estimate: state.estimate,
        openMistakes: 0,
      });
      continue;
    }

    // 4. Secure, and offered last — never presented as something they need.
    if (state.estimate !== null && state.estimate >= SECURE_THRESHOLD) {
      candidates.push({
        conceptId: state.conceptId,
        conceptName: state.conceptName,
        reason: "keep-sharp",
        priority: 9,
        rationale: `You are solid on ${state.conceptName}. Here if you want to keep it that way.`,
        questionCount: MIN_SET,
        estimate: state.estimate,
        openMistakes: 0,
      });
    }
  }

  return candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Within a reason, the weakest first. A null estimate cannot be compared,
    // and cannot reach here anyway except through the mistakes branch.
    const left = a.estimate ?? 1;
    const right = b.estimate ?? 1;
    if (left !== right) return left - right;
    return a.conceptName.localeCompare(b.conceptName);
  });
}

export type Recommendation =
  | { ok: true; candidates: Candidate[] }
  | {
      ok: false;
      /**
       * Why there is nothing to suggest. Three different situations, and they
       * need three different sentences — "sit a test" and "your teacher needs
       * to add questions" are not the same instruction.
       */
      reason: "nothing-measured" | "nothing-to-practise" | "bank-too-thin";
      message: string;
    };

/**
 * The student-facing answer, including the refusal.
 *
 * Modelled as a union rather than an empty array so a screen that renders a
 * recommendation cannot accidentally render nothing and call it encouragement.
 */
export function recommendFor(
  states: ConceptState[],
  now = new Date(),
): Recommendation {
  const measured = states.filter((state) => state.estimate !== null);

  if (measured.length === 0) {
    return {
      ok: false,
      reason: "nothing-measured",
      message:
        "We do not know enough about you yet to suggest anything useful. Sit a test your teacher has set, and this fills in once it is marked.",
    };
  }

  const candidates = recommend(states, now);
  if (candidates.length === 0) {
    // Measured, but nothing servable. Almost always the bank rather than the
    // student, and saying so avoids telling somebody who is doing fine that
    // there is something wrong with them.
    const servable = states.filter((state) => state.available >= MIN_SET);
    return {
      ok: false,
      reason: servable.length === 0 ? "bank-too-thin" : "nothing-to-practise",
      message:
        servable.length === 0
          ? "There are not enough practice questions in your class's bank yet. Your teacher can add some."
          : "Nothing needs work right now — you are on top of everything that has been measured.",
    };
  }

  return { ok: true, candidates };
}
