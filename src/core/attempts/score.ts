/**
 * Marking.
 *
 * Pure, and deliberately so: a score must be re-derivable from the stored
 * answer and the stored key, months later, when a parent disputes it. A
 * marking rule that lives inside a database transaction cannot be shown to
 * anyone.
 *
 * ---------------------------------------------------------------------------
 * The rule that shapes every branch here
 * ---------------------------------------------------------------------------
 * **Null is not zero.**
 *
 *   - A question a person must mark scores `null` until they mark it.
 *   - A question the student never touched scores `null` — they did not answer
 *     it, which is different from answering it wrongly, and the difference
 *     matters when the same paper is being used to say what a student knows.
 *   - Only an answer the student actually gave, which is wrong, scores 0.
 *
 * A null that becomes a 0 inside an average is how a product tells a parent
 * their child failed a question nobody has marked yet.
 */

import {
  isObjective,
  type AnswerKey,
  type Option,
  type QuestionType,
} from "@/core/questions/validate";

export type Response =
  | { kind: "choice"; keys: string[] }
  | { kind: "boolean"; value: boolean }
  | { kind: "numeric"; value: number }
  | { kind: "text"; value: string }
  | null;

export type Marked = {
  /** Null when nobody has marked it, or the student never answered. */
  isCorrect: boolean | null;
  /** Null for the same reasons. Never silently 0. */
  awardedMarks: number | null;
  maxMarks: number;
  /** Why it came out this way — shown to a teacher, and to a student on review. */
  reason:
    | "correct"
    | "incorrect"
    | "partial"
    | "unanswered"
    | "awaiting-marking"
    | "no-key";
};

export type Markable = {
  type: QuestionType;
  maxMarks: number;
  options: Option[] | null;
  answerKey: AnswerKey;
  response: Response;
};

export function markAnswer(item: Markable): Marked {
  const base = { maxMarks: item.maxMarks };

  // A person marks this. Not zero — null, until they do.
  if (!isObjective(item.type)) {
    return {
      ...base,
      isCorrect: null,
      awardedMarks: null,
      reason: "awaiting-marking",
    };
  }

  if (isUnanswered(item.response)) {
    // Untouched. Distinct from answered-and-wrong, and the distinction is the
    // difference between "did not reach it" and "does not know it".
    return { ...base, isCorrect: null, awardedMarks: null, reason: "unanswered" };
  }

  switch (item.type) {
    case "MCQ":
    case "ASSERTION_REASON":
      return markSingleChoice(item, base);
    case "MULTI_SELECT":
      return markMultiSelect(item, base);
    case "TRUE_FALSE":
      return markBoolean(item, base);
    case "NUMERIC":
      return markNumeric(item, base);
    case "FILL_BLANK":
      return markText(item, base);
    default:
      return { ...base, isCorrect: null, awardedMarks: null, reason: "no-key" };
  }
}

// ---------------------------------------------------------------------------

function markSingleChoice(item: Markable, base: { maxMarks: number }): Marked {
  const correct = (item.options ?? [])
    .filter((option) => option.isCorrect)
    .map((option) => option.key);

  if (correct.length === 0) {
    // The validator prevents this, but a question edited outside the product
    // could still reach here. Refuse rather than mark everyone wrong.
    return { ...base, isCorrect: null, awardedMarks: null, reason: "no-key" };
  }

  const given = item.response?.kind === "choice" ? item.response.keys : [];
  const isCorrect = given.length === 1 && correct.includes(given[0]!);

  return {
    ...base,
    isCorrect,
    awardedMarks: isCorrect ? base.maxMarks : 0,
    reason: isCorrect ? "correct" : "incorrect",
  };
}

/**
 * Multi-select: partial credit, and a wrong tick costs.
 *
 * Marks are `(selected correct − selected wrong) / total correct`, floored at
 * zero. Without the penalty, ticking every box scores full marks, which makes
 * the question measure nothing.
 */
function markMultiSelect(item: Markable, base: { maxMarks: number }): Marked {
  const correct = new Set(
    (item.options ?? [])
      .filter((option) => option.isCorrect)
      .map((option) => option.key),
  );
  if (correct.size === 0) {
    return { ...base, isCorrect: null, awardedMarks: null, reason: "no-key" };
  }

  const given = item.response?.kind === "choice" ? item.response.keys : [];
  const hits = given.filter((key) => correct.has(key)).length;
  const misses = given.filter((key) => !correct.has(key)).length;

  const fraction = Math.max(0, (hits - misses) / correct.size);
  const awardedMarks = round2(base.maxMarks * fraction);
  const perfect = hits === correct.size && misses === 0;

  return {
    ...base,
    isCorrect: perfect,
    awardedMarks,
    reason: perfect ? "correct" : awardedMarks > 0 ? "partial" : "incorrect",
  };
}

function markBoolean(item: Markable, base: { maxMarks: number }): Marked {
  if (item.answerKey?.kind !== "boolean") {
    return { ...base, isCorrect: null, awardedMarks: null, reason: "no-key" };
  }
  const given = item.response?.kind === "boolean" ? item.response.value : null;
  const isCorrect = given === item.answerKey.correct;
  return {
    ...base,
    isCorrect,
    awardedMarks: isCorrect ? base.maxMarks : 0,
    reason: isCorrect ? "correct" : "incorrect",
  };
}

/**
 * Numeric, within the tolerance the author set.
 *
 * The tolerance is why a student who rounds differently is not simply wrong,
 * and it is compared inclusively — a value exactly on the boundary is inside
 * it, because an author writing "± 0.5" means 0.5 is acceptable.
 */
function markNumeric(item: Markable, base: { maxMarks: number }): Marked {
  if (item.answerKey?.kind !== "numeric") {
    return { ...base, isCorrect: null, awardedMarks: null, reason: "no-key" };
  }
  const given = item.response?.kind === "numeric" ? item.response.value : null;
  if (given === null || !Number.isFinite(given)) {
    return { ...base, isCorrect: false, awardedMarks: 0, reason: "incorrect" };
  }

  const { value, tolerance } = item.answerKey;
  // A tiny epsilon so binary floating point does not fail an answer that is
  // exactly on the boundary in decimal.
  const isCorrect = Math.abs(given - value) <= tolerance + 1e-9;

  return {
    ...base,
    isCorrect,
    awardedMarks: isCorrect ? base.maxMarks : 0,
    reason: isCorrect ? "correct" : "incorrect",
  };
}

/**
 * Fill-in-the-blank, against the list of forms the author will accept.
 *
 * Whitespace is collapsed and case ignored unless the author said otherwise,
 * because "Square" and "square " are the same answer and marking one wrong
 * teaches a student the product is arbitrary.
 */
function markText(item: Markable, base: { maxMarks: number }): Marked {
  if (item.answerKey?.kind !== "text") {
    return { ...base, isCorrect: null, awardedMarks: null, reason: "no-key" };
  }
  const given = item.response?.kind === "text" ? item.response.value : "";
  const normalise = (value: string) => {
    const collapsed = value.trim().replace(/\s+/g, " ");
    return item.answerKey && item.answerKey.kind === "text" &&
      item.answerKey.caseSensitive
      ? collapsed
      : collapsed.toLowerCase();
  };

  const wanted = item.answerKey.accepted.map(normalise);
  const isCorrect = wanted.includes(normalise(given));

  return {
    ...base,
    isCorrect,
    awardedMarks: isCorrect ? base.maxMarks : 0,
    reason: isCorrect ? "correct" : "incorrect",
  };
}

function isUnanswered(response: Response): boolean {
  if (response === null) return true;
  if (response.kind === "choice") return response.keys.length === 0;
  if (response.kind === "text") return response.value.trim().length === 0;
  if (response.kind === "numeric") return !Number.isFinite(response.value);
  return false;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export type ScoreSummary = {
  /** Marks actually awarded so far. */
  rawScore: number;
  /** The whole paper. */
  maxScore: number;
  percentage: number;
  /**
   * Marks still waiting on a person.
   *
   * NOT every unscored mark: a question left blank is settled at nothing and
   * is excluded. The same distinction the student's result page makes, and it
   * has to be made in one place or the two drift apart.
   */
  pendingMarks: number;
  answered: number;
  unanswered: number;
  correct: number;
  incorrect: number;
  awaitingMarking: number;
  /** True when a person still has work to do before this score is final. */
  provisional: boolean;
};

export function summarise(marks: Marked[]): ScoreSummary {
  let rawScore = 0;
  let maxScore = 0;
  let pendingMarks = 0;
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;
  let awaitingMarking = 0;

  for (const mark of marks) {
    maxScore += mark.maxMarks;

    if (mark.awardedMarks === null) {
      // Unscored, but not all unscored marks are pending. A written answer
      // waiting on a teacher may still earn its marks; an objective question
      // the student never touched never will. Counting the blank one here
      // promises a student marks that are not coming, and the teacher's class
      // list would show marking outstanding that nobody can ever do.
      if (mark.reason === "awaiting-marking" || mark.reason === "no-key") {
        pendingMarks += mark.maxMarks;
      }
    } else {
      rawScore += mark.awardedMarks;
    }

    switch (mark.reason) {
      case "correct":
        correct++;
        break;
      case "partial":
        correct += 0;
        incorrect += 0;
        break;
      case "incorrect":
        incorrect++;
        break;
      case "unanswered":
        unanswered++;
        break;
      case "awaiting-marking":
      case "no-key":
        awaitingMarking++;
        break;
    }
  }

  const answered = marks.length - unanswered;

  return {
    rawScore: round2(rawScore),
    maxScore: round2(maxScore),
    percentage: maxScore > 0 ? round2((rawScore / maxScore) * 100) : 0,
    pendingMarks: round2(pendingMarks),
    answered,
    unanswered,
    correct,
    incorrect,
    awaitingMarking,
    provisional: awaitingMarking > 0,
  };
}
