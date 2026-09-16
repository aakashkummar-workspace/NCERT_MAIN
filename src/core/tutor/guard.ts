/**
 * Did the tutor give the answer away?
 *
 * Pure, deterministic, and checked on every turn before anything reaches a
 * student — the same shape as `checkForLeaks` in the AI layer, and for the same
 * reason: a rule the prompt states is a rule the model follows most of the time,
 * and "most of the time" is not a property you can build a feature on.
 *
 * ---------------------------------------------------------------------------
 * Why this is the whole feature
 * ---------------------------------------------------------------------------
 * A tutor that answers the question is a homework machine. It would be popular,
 * it would produce excellent-looking usage numbers, and every student using it
 * would learn less than one without it — which the marks would show a term
 * later, by which point the product has taught a cohort that it is a way of not
 * thinking.
 *
 * So the model is told not to state the answer, AND the output is checked. When
 * the check fires, the authored hint is served instead and the turn is stamped
 * `wasWithheld` — counted rather than hidden, because if it is not rare then
 * the prompt is wrong and somebody needs to be able to see that.
 */

export type Option = { key: string; text: string; isCorrect?: boolean };

export type AnswerKey =
  | { kind: "choice"; correct: string[] }
  | { kind: "boolean"; correct: boolean }
  | { kind: "numeric"; value: number; tolerance?: number }
  | { kind: "text"; accepted: string[] }
  | null;

/**
 * A phrase this short is not a giveaway.
 *
 * "AA" is a real answer to a similarity question and also two letters that
 * occur inside ordinary words. Checking it as a substring would reject every
 * hint mentioning "Australia"; checking it as a whole word is right, and short
 * option text is checked that way below.
 */
const MIN_PHRASE = 3;

/** Whole-word containment, so "AA" does not match inside "AArambh". */
function containsWord(haystack: string, needle: string): boolean {
  const trimmed = needle.trim();
  if (trimmed.length === 0) return false;

  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = trimmed.toLowerCase();

  let from = 0;
  for (;;) {
    const at = lowerHay.indexOf(lowerNeedle, from);
    if (at === -1) return false;

    const before = at === 0 ? " " : lowerHay[at - 1]!;
    const after =
      at + lowerNeedle.length >= lowerHay.length
        ? " "
        : lowerHay[at + lowerNeedle.length]!;

    // Bounded by anything that is not a letter or digit on both sides.
    const isBoundary = (character: string) => !/[a-z0-9]/.test(character);
    if (isBoundary(before) && isBoundary(after)) return true;

    from = at + 1;
  }
}

export type LeakVerdict =
  | { leaked: false }
  | { leaked: true; what: "option" | "boolean" | "numeric" | "text" };

/**
 * Whether a tutor turn hands over the answer.
 *
 * Deliberately conservative about MULTIPLE CHOICE and permissive about method.
 * A hint may name the concept, the theorem, even the formula — all of that is
 * teaching. What it may not do is say which option, what number, or the exact
 * accepted words.
 */
export function leaksAnswer(
  text: string,
  options: Option[] | null,
  answerKey: AnswerKey,
): LeakVerdict {
  if (options && options.length > 0) {
    const correct = options.filter((option) => option.isCorrect);

    for (const option of correct) {
      // The option's own text, whole-word. Short text like "AA" or "4 : 9" is
      // exactly the kind that gives it away in one token.
      if (option.text.trim().length >= MIN_PHRASE) {
        if (containsWord(text, option.text)) return { leaked: true, what: "option" };
      } else if (containsWord(text, option.text)) {
        return { leaked: true, what: "option" };
      }

      const key = option.key.trim();
      if (key.length > 0 && namesTheKey(text, key)) {
        return { leaked: true, what: "option" };
      }
    }
    return { leaked: false };
  }

  if (!answerKey) return { leaked: false };

  if (answerKey.kind === "boolean") {
    // "It is true that…" is ordinary English, so only a stated verdict counts.
    const stated = answerKey.correct
      ? /\b(?:answer|statement)\s+is\s+true\b|\bthe\s+answer\s+is\s+true\b/i
      : /\b(?:answer|statement)\s+is\s+false\b|\bthe\s+answer\s+is\s+false\b/i;
    return stated.test(text) ? { leaked: true, what: "boolean" } : { leaked: false };
  }

  if (answerKey.kind === "numeric") {
    // The value as a standalone number. A hint may say "square the ratio";
    // it may not say "so it is 9".
    const value = String(answerKey.value);
    return containsWord(text, value)
      ? { leaked: true, what: "numeric" }
      : { leaked: false };
  }

  if (answerKey.kind === "text") {
    for (const accepted of answerKey.accepted) {
      if (accepted.trim().length < MIN_PHRASE) continue;
      if (containsWord(text, accepted)) return { leaked: true, what: "text" };
    }
    return { leaked: false };
  }

  return { leaked: false };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the reply points at an option key rather than merely containing it.
 *
 * A lone "B" is ordinary in geometry — triangle B, point B — so the key alone
 * cannot be the trigger. What makes it a giveaway is the frame around it: a
 * noun that names it as the answer, or a verb telling the student to pick it.
 *
 * The linking verbs are not decoration. The first version required the key to
 * follow the noun directly ("option B", "answer: B") and therefore missed
 * "The answer is B" — which is the single likeliest sentence a model would
 * write if it were going to leak at all. A unit test caught it before anything
 * shipped, which is the whole argument for this file existing.
 */
function namesTheKey(text: string, key: string): boolean {
  const k = escapeRegExp(key);
  const linking = "(?:\\s+(?:is|are|would\\s+be|will\\s+be|must\\s+be|should\\s+be))?";
  const patterns = [
    // "option B", "the answer is B", "answer: (B)", "correct choice — B"
    new RegExp(`\\b(?:option|answer|choice)\\b${linking}\\s*[:\\-–—]?\\s*\\(?${k}\\)?\\b`, "i"),
    // "pick B", "go with (B)", "tick B"
    new RegExp(`\\b(?:pick|choose|select|tick|mark|go\\s+with)\\s+\\(?${k}\\)?\\b`, "i"),
    // "it's B", "it is B" — a bare verdict with no noun at all.
    new RegExp(`\\bit(?:'s|\\s+is)\\s+\\(?${k}\\)?\\b`, "i"),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export type Level = "HINT" | "STEPS" | "EXPLAIN";

const LADDER: Level[] = ["HINT", "STEPS", "EXPLAIN"];

/**
 * The next rung, or the top.
 *
 * One-way. A student who has seen the method cannot un-see it, so offering to
 * go back down would be offering something that no longer exists — and the
 * record of how much help they needed has to be monotonic for the evidence rule
 * to mean anything.
 */
export function nextLevel(current: Level | null): Level {
  if (current === null) return "HINT";
  const index = LADDER.indexOf(current);
  return LADDER[Math.min(LADDER.length - 1, index + 1)]!;
}

export function isTop(level: Level): boolean {
  return level === LADDER[LADDER.length - 1];
}

/** What the button says, and what the student is agreeing to see. */
export const LEVEL_LABEL: Record<Level, string> = {
  HINT: "Give me a hint",
  STEPS: "Show me the steps",
  EXPLAIN: "Explain it differently",
};

export const LEVEL_BLURB: Record<Level, string> = {
  HINT: "A nudge at what to look at. It will not do any of it for you.",
  STEPS: "The method, step by step — with the working left to you.",
  EXPLAIN: "The idea behind it, said another way.",
};
