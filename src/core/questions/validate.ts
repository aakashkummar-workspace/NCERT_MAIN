/**
 * Question validation.
 *
 * The gate every question passes, whoever wrote it. A teacher typing one meets
 * it live in the editor; the server applies it again on save; and when AI
 * generation arrives it will run through this same function before a draft ever
 * reaches a human. One implementation, so "valid" means the same thing in all
 * three places.
 *
 * Pure — no database, no I/O, no `server-only` — for exactly that reason.
 *
 * ---------------------------------------------------------------------------
 * Errors block; warnings do not
 * ---------------------------------------------------------------------------
 * An ERROR means the question would be wrong in a real exam: two correct
 * answers on a single-answer item, a key pointing at an option that does not
 * exist. Those cannot be approved, because the cost lands on a student.
 *
 * A WARNING means it is probably worse than it could be — an "all of the above"
 * option, a stem shorter than its choices. An author may know better than a
 * heuristic, so these are shown and never enforced.
 */

export type QuestionType =
  | "MCQ"
  | "MULTI_SELECT"
  | "TRUE_FALSE"
  | "NUMERIC"
  | "FILL_BLANK"
  | "ASSERTION_REASON"
  | "VSA"
  | "SA"
  | "LA"
  | "CASE_STUDY";

export type Option = { key: string; text: string; isCorrect: boolean };

export type AnswerKey =
  | { kind: "choice"; correctKeys: string[] }
  | { kind: "boolean"; correct: boolean }
  | { kind: "numeric"; value: number; tolerance: number; unit?: string }
  | { kind: "text"; accepted: string[]; caseSensitive: boolean }
  | null;

export type QuestionDraft = {
  type: QuestionType;
  stem: string;
  options?: Option[] | null;
  answerKey?: AnswerKey;
  explanation?: string | null;
  hint?: string | null;
  marks: number;
  outcomeIds?: string[];
};

export type Problem = {
  severity: "error" | "warning";
  field: "stem" | "options" | "answerKey" | "marks" | "explanation" | "outcomes";
  message: string;
};

export type Validation = {
  problems: Problem[];
  /** No errors. Warnings may still be present. */
  valid: boolean;
  /** No errors AND mapped to an outcome — the bar for approval. */
  approvable: boolean;
};

/** Types a machine can mark. Everything else is a person's judgement. */
export const OBJECTIVE_TYPES: readonly QuestionType[] = [
  "MCQ",
  "MULTI_SELECT",
  "TRUE_FALSE",
  "NUMERIC",
  "FILL_BLANK",
  "ASSERTION_REASON",
];

export const SUBJECTIVE_TYPES: readonly QuestionType[] = [
  "VSA",
  "SA",
  "LA",
  "CASE_STUDY",
];

export function isObjective(type: QuestionType): boolean {
  return OBJECTIVE_TYPES.includes(type);
}

/** Types that carry a list of choices. */
export function hasOptions(type: QuestionType): boolean {
  return type === "MCQ" || type === "MULTI_SELECT" || type === "ASSERTION_REASON";
}

const VAGUE_OPTION =
  /^(all of the above|none of the above|both a and b|all of these|none of these|any of the above)$/i;

export function validateQuestion(draft: QuestionDraft): Validation {
  const problems: Problem[] = [];
  const error = (field: Problem["field"], message: string) =>
    problems.push({ severity: "error", field, message });
  const warn = (field: Problem["field"], message: string) =>
    problems.push({ severity: "warning", field, message });

  // ---- Stem --------------------------------------------------------------
  const stem = draft.stem.trim();
  if (stem.length === 0) {
    error("stem", "The question has no text.");
  } else if (stem.length < 10) {
    error("stem", "Too short to be a question a student could answer.");
  } else if (stem.length > 4000) {
    error("stem", "Longer than any exam question. Split it or trim it.");
  }

  // ---- Marks -------------------------------------------------------------
  if (!Number.isInteger(draft.marks) || draft.marks < 1) {
    error("marks", "Marks must be a whole number, at least 1.");
  } else if (draft.marks > 20) {
    error("marks", "More than 20 marks for one question is almost certainly a typo.");
  } else if (draft.type === "MCQ" && draft.marks > 4) {
    warn(
      "marks",
      "A multiple-choice question carrying more than 4 marks is unusual. Check this is what you meant.",
    );
  }

  // ---- Options and answer key, by type ------------------------------------
  const options = draft.options ?? [];

  if (hasOptions(draft.type)) {
    validateChoices(draft, options, error, warn);
  } else if (options.length > 0) {
    warn(
      "options",
      "This question type does not use options. They will not be shown to a student.",
    );
  }

  switch (draft.type) {
    case "TRUE_FALSE":
      if (!draft.answerKey || draft.answerKey.kind !== "boolean") {
        error("answerKey", "Say whether the statement is true or false.");
      }
      break;

    case "NUMERIC":
      validateNumeric(draft.answerKey, error, warn);
      break;

    case "FILL_BLANK":
      validateText(draft, error, warn);
      break;

    default:
      break;
  }

  if (SUBJECTIVE_TYPES.includes(draft.type)) {
    if (draft.answerKey) {
      // Not merely tidiness: a subjective answer scores null until a person
      // marks it, and an answer key here would invite an automatic zero.
      warn(
        "answerKey",
        "This type is marked by a person, so an answer key is not used. Put the expected response in the explanation instead.",
      );
    }
    if (!draft.explanation?.trim()) {
      warn(
        "explanation",
        "Written answers are much faster to mark when the expected points are written down first.",
      );
    }
  }

  // ---- Explanation --------------------------------------------------------
  if (isObjective(draft.type) && !draft.explanation?.trim()) {
    warn(
      "explanation",
      "Without an explanation, a student who got this wrong learns only that they were wrong.",
    );
  }

  // ---- Outcome mapping ----------------------------------------------------
  const outcomes = draft.outcomeIds ?? [];
  if (outcomes.length === 0) {
    // Deliberately a warning while drafting and a bar at approval: a question
    // with no outcome can be scored but can never inform mastery, which makes
    // it worthless to the part of the product that matters.
    warn(
      "outcomes",
      "Not linked to a learning outcome. It can still be scored, but it will not tell you anything about what a student has mastered.",
    );
  }

  const errors = problems.filter((problem) => problem.severity === "error");
  return {
    problems,
    valid: errors.length === 0,
    approvable: errors.length === 0 && outcomes.length > 0,
  };
}

// ---------------------------------------------------------------------------

function validateChoices(
  draft: QuestionDraft,
  options: Option[],
  error: (field: Problem["field"], message: string) => void,
  warn: (field: Problem["field"], message: string) => void,
) {
  if (options.length < 2) {
    error("options", "A choice question needs at least two options.");
    return;
  }
  if (options.length > 8) {
    error("options", "More than eight options is not a question, it is a list.");
  }

  const blank = options.filter((option) => option.text.trim().length === 0);
  if (blank.length > 0) {
    error("options", `${blank.length} option(s) have no text.`);
  }

  const keys = options.map((option) => option.key);
  if (new Set(keys).size !== keys.length) {
    error("options", "Two options share the same letter.");
  }

  const seen = new Map<string, number>();
  for (const option of options) {
    const normalised = option.text.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalised) continue;
    seen.set(normalised, (seen.get(normalised) ?? 0) + 1);
  }
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
  if (duplicated.length > 0) {
    error(
      "options",
      "Two options say the same thing, so more than one answer would be correct.",
    );
  }

  const correct = options.filter((option) => option.isCorrect);

  if (draft.type === "MCQ" || draft.type === "ASSERTION_REASON") {
    if (correct.length === 0) {
      error("options", "No option is marked correct.");
    } else if (correct.length > 1) {
      // The failure that costs a student a mark they earned.
      error(
        "options",
        `${correct.length} options are marked correct, but this type accepts one. Change the type to multi-select, or unmark the others.`,
      );
    }
  }

  if (draft.type === "MULTI_SELECT") {
    if (correct.length === 0) {
      error("options", "No option is marked correct.");
    } else if (correct.length === options.length) {
      error("options", "Every option is marked correct, so the question asks nothing.");
    } else if (correct.length === 1) {
      warn(
        "options",
        "Only one option is correct. A single-answer question is usually clearer as multiple choice.",
      );
    }
  }

  for (const option of options) {
    if (VAGUE_OPTION.test(option.text.trim())) {
      warn(
        "options",
        `“${option.text.trim()}” tests reading strategy more than the subject. Prefer a specific alternative.`,
      );
      break;
    }
  }

  // A stem shorter than its options usually means the question is being asked
  // by the choices, which is where ambiguity lives.
  const longestOption = Math.max(...options.map((o) => o.text.trim().length));
  if (draft.stem.trim().length < longestOption) {
    warn(
      "stem",
      "The question is shorter than its longest option. Move the substance into the question.",
    );
  }

  // A correct option that is conspicuously longer than the rest is the oldest
  // giveaway in multiple choice.
  const correctOption = correct[0];
  if (correctOption && options.length > 2) {
    const others = options.filter((o) => o !== correctOption);
    const averageOther =
      others.reduce((sum, o) => sum + o.text.trim().length, 0) / others.length;
    if (
      correctOption.text.trim().length > 24 &&
      correctOption.text.trim().length > averageOther * 2
    ) {
      warn(
        "options",
        "The correct option is much longer than the others, which students learn to spot. Even them up.",
      );
    }
  }
}

function validateNumeric(
  answerKey: AnswerKey | undefined,
  error: (field: Problem["field"], message: string) => void,
  warn: (field: Problem["field"], message: string) => void,
) {
  if (!answerKey || answerKey.kind !== "numeric") {
    error("answerKey", "Give the numeric answer.");
    return;
  }
  // A blank box is NOT zero. The editor used to turn "" into 0 with Number(),
  // and a question with no answer then marked every student who wrote 0 right
  // and everybody else wrong. Callers pass NaN (or nothing) for blank.
  if (typeof answerKey.value !== "number" || Number.isNaN(answerKey.value)) {
    error("answerKey", "Give the numeric answer. A blank answer is not zero.");
  } else if (!Number.isFinite(answerKey.value)) {
    error("answerKey", "The answer is not a number.");
  }
  if (!Number.isFinite(answerKey.tolerance) || answerKey.tolerance < 0) {
    error("answerKey", "Tolerance must be zero or more.");
  } else if (answerKey.tolerance === 0) {
    warn(
      "answerKey",
      "With zero tolerance, a student who rounds differently is marked wrong. Allow a small margin unless the answer is exact.",
    );
  } else if (
    Number.isFinite(answerKey.value) &&
    answerKey.value !== 0 &&
    answerKey.tolerance > Math.abs(answerKey.value) * 0.5
  ) {
    warn(
      "answerKey",
      "The tolerance is more than half the answer, so almost anything would be accepted.",
    );
  }
}

function validateText(
  draft: QuestionDraft,
  error: (field: Problem["field"], message: string) => void,
  warn: (field: Problem["field"], message: string) => void,
) {
  const key = draft.answerKey;
  if (!key || key.kind !== "text") {
    error("answerKey", "Give at least one accepted answer.");
    return;
  }
  const accepted = key.accepted.map((a) => a.trim()).filter(Boolean);
  if (accepted.length === 0) {
    error("answerKey", "Give at least one accepted answer.");
    return;
  }
  if (new Set(accepted.map((a) => a.toLowerCase())).size !== accepted.length) {
    warn("answerKey", "The same answer is listed twice.");
  }
  if (accepted.length === 1 && accepted[0]!.length > 40) {
    warn(
      "answerKey",
      "A long single answer will fail on wording a student got right. List the acceptable forms, or use a written-answer type.",
    );
  }
  if (!draft.stem.includes("___") && !draft.stem.includes("_____")) {
    warn(
      "stem",
      "Mark the blank in the question text with underscores, so a student can see what is missing.",
    );
  }
}
