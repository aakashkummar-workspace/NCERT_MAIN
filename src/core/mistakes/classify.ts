/**
 * What kind of mistake this was.
 *
 * Pure, and rules first. Both halves of that matter.
 *
 * ---------------------------------------------------------------------------
 * Rules first, because volume beats unit price
 * ---------------------------------------------------------------------------
 * Classification runs once per wrong answer, which makes it the largest single
 * line in the modelled AI bill — not because a call is expensive but because
 * there are so many of them. A blank answer needs no model to be recognised as
 * blank, and neither does one submitted with four seconds left on the clock.
 * Every case a rule can settle is a case that costs nothing and cannot be
 * wrong, so the model is asked only about the genuinely ambiguous remainder —
 * which is also the only part where its judgement is worth anything.
 *
 * ---------------------------------------------------------------------------
 * CARELESS versus CONCEPTUAL is the distinction that changes what happens next
 * ---------------------------------------------------------------------------
 * "You do not understand similar triangles" and "you knew that and rushed it"
 * lead to different evenings. Getting it wrong in the confident direction is
 * the worse failure: telling a student who understands the topic that they do
 * not is how a revision tool teaches somebody they are bad at Mathematics. So
 * the CARELESS rule needs corroboration — speed alone is not enough, because a
 * student who does not know something also answers quickly.
 */

export type MistakeType =
  | "CONCEPTUAL"
  | "PROCEDURAL"
  | "CARELESS"
  | "UNATTEMPTED"
  | "MISREAD"
  | "TIME_PRESSURE"
  | "UNCLASSIFIED";

export type Verdict = {
  type: MistakeType;
  /** RULE settles it now and for free. PENDING sends it to the nightly batch. */
  source: "RULE" | "PENDING";
  /** Shown to the student. Written for them, not for a log. */
  reason: string | null;
};

export type AnswerFacts = {
  /** Null or an empty response is a blank, whatever the question type. */
  responded: boolean;
  timeSpentSeconds: number;
  /** What the author said it should take. Null for most questions. */
  expectedTimeSeconds: number | null;
  /** Seconds between this answer and the moment the paper was submitted. */
  secondsBeforeSubmit: number | null;
  /** True when the paper ended because the clock ran out, not by choice. */
  ranOutOfTime: boolean;
  /** How many times they opened this question. Once is a glance. */
  visitCount: number;
  /**
   * Whether there is any working to read — text the student wrote, rather than
   * an option they picked. Without it a model has a choice and nothing else.
   */
  hasWriting: boolean;
  /**
   * Their mastery of the concept at the time, when there is one. This is what
   * makes CARELESS sayable: a wrong answer on something they can demonstrably
   * do is a slip, and the same wrong answer without that evidence is not.
   */
  conceptEstimate: number | null;
  type: string;
};

/**
 * Fast enough to be suspicious, when we know what the question should take.
 *
 * A quarter of the author's estimate. Without an estimate this rule does not
 * fire at all — a hard-coded "under ten seconds" would call every one-mark
 * true/false answer careless.
 */
const RUSH_FRACTION = 0.25;

/** Answering inside the last minute of a paper that then timed out. */
const ENDGAME_SECONDS = 60;

/**
 * Above this, they can demonstrably do the concept, so a wrong answer on it is
 * more likely a slip than a hole. Deliberately the same 0.6 the mastery scale
 * and the gap threshold use — one boundary, read three ways, rather than three
 * that nearly agree.
 */
const COMPETENT = 0.6;

/** Two options. Getting it wrong is one bit, and one bit explains nothing. */
const BINARY = new Set(["TRUE_FALSE"]);

export function classify(facts: AnswerFacts): Verdict {
  // 1. Blank. Free, certain, and it means something different from wrong: they
  //    did not try, which is a conversation about the paper rather than about
  //    the concept.
  if (!facts.responded) {
    if (facts.ranOutOfTime) {
      return {
        type: "TIME_PRESSURE",
        source: "RULE",
        reason: "You did not get to this one before the time ran out.",
      };
    }
    return {
      type: "UNATTEMPTED",
      source: "RULE",
      reason: "You left this blank.",
    };
  }

  // 2. Answered in the endgame of a paper that then timed out. The answer
  //    exists, but it was written against a clock — which says nothing about
  //    whether they know the topic.
  if (
    facts.ranOutOfTime &&
    facts.secondsBeforeSubmit !== null &&
    facts.secondsBeforeSubmit <= ENDGAME_SECONDS
  ) {
    return {
      type: "TIME_PRESSURE",
      source: "RULE",
      reason: "You answered this in the last minute, with the clock running out.",
    };
  }

  // 3. Rushed something they can do. BOTH halves are required. Speed alone
  //    describes a student who did not know it either, and calling that
  //    carelessness tells somebody who is stuck that they were merely sloppy —
  //    the one error here that actively misleads.
  const expected = facts.expectedTimeSeconds;
  const rushed =
    expected !== null && expected > 0 && facts.timeSpentSeconds < expected * RUSH_FRACTION;
  const competent = facts.conceptEstimate !== null && facts.conceptEstimate >= COMPETENT;

  if (rushed && competent && facts.visitCount <= 1) {
    return {
      type: "CARELESS",
      source: "RULE",
      reason:
        "You usually get this concept right, and you spent very little time here. Worth a second look rather than a re-read of the chapter.",
    };
  }

  // 4. A wrong true/false, with no working. There are two options and they
  //    picked the other one: that is one bit, and one bit cannot distinguish
  //    "does not understand" from "misread" from "guessed". A model asked
  //    about it can only invent an explanation, and an invented explanation
  //    told confidently to a student is the failure this whole file is
  //    arranged to avoid. So it is settled here — as undecided, for free, and
  //    it never joins the nightly queue to be answered UNSURE at a cost.
  if (BINARY.has(facts.type) && !facts.hasWriting) {
    return {
      type: "UNCLASSIFIED",
      source: "RULE",
      reason:
        "There are only two answers here, so there is nothing to tell us why this one went wrong. Read the explanation and see if it lands.",
    };
  }

  // 5. Everything else is a judgement about the answer's content — whether
  //    they misread the question, slipped in the working, or do not have the
  //    idea. A rule cannot tell those apart, and they are exactly the three
  //    worth paying a model to separate. A wrong option on a multiple choice
  //    DOES carry information — which distractor they chose often names the
  //    misconception — which is why it is here and true/false is above.
  return { type: "UNCLASSIFIED", source: "PENDING", reason: null };
}

/**
 * Whether this verdict should go to the nightly model batch.
 *
 * Written as its own function because the batch job and the recorder must
 * agree about it; two copies of "is it pending" is how a queue quietly stops
 * draining.
 */
export function needsModel(verdict: { source: string; type: string }): boolean {
  return verdict.source === "PENDING";
}

const LABEL: Record<MistakeType, string> = {
  CONCEPTUAL: "Concept not secure",
  PROCEDURAL: "Slip in the working",
  CARELESS: "Rushed",
  UNATTEMPTED: "Left blank",
  MISREAD: "Misread the question",
  TIME_PRESSURE: "Ran out of time",
  UNCLASSIFIED: "Not looked at yet",
};

export function labelFor(type: string): string {
  return LABEL[type as MistakeType] ?? "Not looked at yet";
}

/**
 * What to do about it, by type.
 *
 * The whole point of typing a mistake. "You got this wrong" is a fact the
 * student already had; "you know this, you rushed it" is the first thing on
 * the page that changes what they do next.
 *
 * Every line has to work in the order the page actually happens: the
 * explanation is WITHHELD until they have had another go, so advice that says
 * "read the explanation first" is advice the screen cannot obey. A screenshot
 * caught that on the CONCEPTUAL line, where it also contradicted the only
 * control on the page.
 */
const ADVICE: Record<MistakeType, string> = {
  CONCEPTUAL:
    "This one is about the idea rather than a slip, so try it and then read the explanation properly — that is where the fix is.",
  PROCEDURAL:
    "You had the right idea. Work it through on paper and find the step that went wrong.",
  CARELESS: "Read it once more, slowly. You can do this one.",
  UNATTEMPTED: "Have a go at it now, with no clock on you.",
  MISREAD:
    "Read the question again before you answer. The method you used was fine for a different question.",
  TIME_PRESSURE:
    "The clock beat you, not the question. Try it untimed and see where you actually stand.",
  UNCLASSIFIED: "Have another go and see what happens.",
};

export function adviceFor(type: string): string {
  return ADVICE[type as MistakeType] ?? ADVICE.UNCLASSIFIED;
}
