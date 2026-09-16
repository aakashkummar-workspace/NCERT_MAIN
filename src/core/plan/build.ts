/**
 * What to do next, in order.
 *
 * Pure, for the same reason the mastery estimator and the recommender are: this
 * is the function that decides how a fifteen-year-old spends their evening, and
 * a student who disagrees with it should be able to be shown the rule.
 *
 * ---------------------------------------------------------------------------
 * A plan is an ORDER, never a timetable
 * ---------------------------------------------------------------------------
 * There are no dates here, no durations, and no "Monday: 30 minutes of
 * trigonometry". Three reasons, and they compound:
 *
 *   - It is a promise about somebody else's evening that this product has no
 *     way to keep. It does not know about the wedding on Saturday, the younger
 *     sibling, or the two hours of tuition already booked.
 *   - A schedule is wrong by Tuesday, and a plan that is already behind is one
 *     a student closes rather than one they catch up on.
 *   - "Thirty minutes" implies the thirty minutes is what matters. It is not;
 *     the concept is.
 *
 * So the plan says what to do first, second and third, and stops.
 *
 * ---------------------------------------------------------------------------
 * It never reads what a paper is about
 * ---------------------------------------------------------------------------
 * The tempting version of the revise item names the concepts the coming test
 * actually covers — the product can derive them, the paper is frozen at publish
 * and the two-hop from questions to concepts already exists.
 *
 * It is the wrong feature. Telling a student the concept mix of a paper they
 * have not sat narrows their revision on the teacher's behalf, and the teacher
 * chose the paper. So the plan uses only what the student can already see —
 * that there is a Mathematics test on Thursday — and pairs it with what the
 * product knows about THEM: which Mathematics concepts they are weakest on. The
 * sentence is just as useful and it gives nothing away.
 *
 * ---------------------------------------------------------------------------
 * An item leaves when the evidence changes, and on nothing else
 * ---------------------------------------------------------------------------
 * Nothing here is stored, and there is no route that ticks an item off. The
 * plan is derived at read time, exactly as an assignment's status is: a stored
 * plan is stale the moment a student practises, and a plan with checkboxes
 * measures how tidy somebody is rather than what they know.
 *
 * The same rule as a learning gap and as a mistake, which is not a coincidence
 * — it is the same claim about what evidence is for.
 */

import { recommend, type Candidate, type ConceptState } from "@/core/practice/recommend";

/**
 * How many items a plan may hold.
 *
 * Five, and it is a real constraint rather than a round number: a list of
 * fourteen things is one nobody starts, and the whole value of a plan over the
 * practice page is that somebody else did the choosing.
 */
export const MAX_ITEMS = 5;

/**
 * How far ahead a scheduled test is worth revising for.
 *
 * A test three weeks out is not this week's problem, and putting it at the top
 * of the plan every day for three weeks teaches the student to ignore the top
 * of the plan.
 */
export const REVISE_WINDOW_DAYS = 7;

/** At most this many practice items, so a plan is not five identical cards. */
export const MAX_PRACTICE_ITEMS = 2;

export type PlanConcept = ConceptState & {
  /** Which subjects this concept is tested by, for matching a coming test. */
  subjectNames: string[];
};

export type PlanTest = {
  assignmentId: string;
  title: string;
  subjectName: string;
  opensAt: Date;
  closesAt: Date;
  status: "SCHEDULED" | "OPEN" | "CLOSED" | "CANCELLED";
  /** False once they have used every attempt, or while the window is shut. */
  canStart: boolean;
  /** A sitting left unfinished. Resuming it beats starting another. */
  inProgressAttemptId: string | null;
  /**
   * Sittings already made, finished or not. A paper with a second attempt
   * allowed is still startable after the first, and without this the plan
   * went on telling a student to "Sit" a paper they had just sat.
   */
  attemptsUsed: number;
};

export type PlanItemKind =
  | "assigned-practice"
  | "resume-test"
  | "sit-test"
  | "revise-for-test"
  | "fix-mistakes"
  | "practise";

export type PlanItem = {
  kind: PlanItemKind;
  /** The instruction. Imperative, and specific enough to act on. */
  title: string;
  /** Why it is here, built from the numbers that put it here. */
  why: string;
  href: string;
  actionLabel: string;
  /** Set when the item is about one concept, so the page can avoid repeats. */
  conceptId: string | null;
  /**
   * True when something else decided this — a window closing, a paper open.
   * These are not subject to the item cap; a deadline is not discretionary.
   */
  deadline: boolean;
};

export type Plan =
  | { ok: true; items: PlanItem[] }
  | {
      ok: false;
      /**
       * Why there is no plan. Two situations, two sentences — "we do not know
       * anything about you yet" and "there is genuinely nothing to fix" are
       * opposite facts and must never share a message.
       */
      reason: "nothing-yet" | "all-clear";
      message: string;
    };

function daysUntil(date: Date, now: Date): number {
  return (date.getTime() - now.getTime()) / 86_400_000;
}

/**
 * The calendar day a moment falls on, in India, as a day number.
 *
 * Pinned to Asia/Kolkata for the reason the i18n seam pins it: a server on UTC
 * puts a 00:30 IST deadline on the previous day. The parts are read through
 * `Intl` rather than by adding five and a half hours, so nothing here depends
 * on the server's own zone.
 */
function kolkataDay(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000);
}

/**
 * "today", "tomorrow", "in 3 days" — by CALENDAR day, not in 24-hour blocks.
 *
 * Blocks said "tomorrow" about a window 47 hours away that Home, beside it,
 * called two days off, and "today" about one shutting at nine tomorrow
 * morning. A student reads "tomorrow" as a date. Null once the moment has
 * passed, so a caller has to say something true instead of "shuts already".
 */
export function whenPhrase(date: Date, now: Date): string | null {
  if (date.getTime() <= now.getTime()) return null;
  const days = kolkataDay(date) - kolkataDay(now);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** "The window shuts tomorrow." — or that it has shut, never "shuts already". */
function shutsSentence(closesAt: Date, now: Date): string {
  const when = whenPhrase(closesAt, now);
  return when === null ? "The window has shut." : `The window shuts ${when}.`;
}

/**
 * The plan, best first.
 *
 * Deadlines are not capped and discretionary items are. A student with four
 * papers open this week has a plan that is four papers long, and padding it
 * with practice would be the product competing with their teacher for the same
 * evening.
 */
/** One teacher instruction, as the plan needs it. */
export type PlanAssignedPractice = {
  id: string;
  conceptId: string;
  conceptName: string;
  questionCount: number;
  dueAt: Date | null;
  className: string;
  inProgress: boolean;
};

export function buildPlan(
  input: {
    tests: PlanTest[];
    concepts: PlanConcept[];
    /** Open mistakes across every concept. */
    openMistakes: number;
    /**
     * The concept most of those mistakes are about, when there is one.
     *
     * Carried because "you have five questions to fix" and "you have five
     * questions to fix, mostly about ratio" are different amounts of help, and
     * the second is what makes somebody open the list.
     */
    mistakeConceptName?: string | null;
    /**
     * Practice a teacher asked for, not yet done.
     *
     * A deadline item, so it is never trimmed by MAX_ITEMS: the cap exists to
     * stop the product competing for a student evening with its own
     * suggestions, and a teachers instruction is not the products suggestion.
     */
    assignedPractice?: PlanAssignedPractice[];
  },
  now = new Date(),
): Plan {
  const deadlines: PlanItem[] = [];
  const discretionary: PlanItem[] = [];

  // --- 1. A paper already begun -------------------------------------------
  //
  // Above everything. A half-finished sitting is time already spent that is
  // about to be lost, and no amount of practice is worth more than finishing
  // it.
  for (const test of input.tests) {
    if (test.status !== "OPEN" || test.inProgressAttemptId === null) continue;
    deadlines.push({
      kind: "resume-test",
      title: `Finish ${test.title}`,
      why: `You started this and did not submit it. ${shutsSentence(test.closesAt, now)}`,
      href: `/student/attempt/${test.inProgressAttemptId}`,
      actionLabel: "Carry on",
      conceptId: null,
      deadline: true,
    });
  }

  // --- 1b. Practice a teacher asked for ------------------------------------
  //
  // Under a half-finished paper and above everything else: somebody asked for
  // it, which is more than the product can say about its own suggestions.
  //
  // A due date is stated as WHEN, never as a penalty — "asked for by
  // tomorrow", and for one already past "it was asked for earlier, it still
  // counts". A fact, not a reproach: a plan that scolds is a plan a student
  // closes. It goes through `whenPhrase` like every other date here, so no
  // weekday and no clock time reaches a plan item.
  for (const set of input.assignedPractice ?? []) {
    const when = set.dueAt ? whenPhrase(set.dueAt, now) : null;
    const overdue = set.dueAt !== null && set.dueAt.getTime() < now.getTime();
    deadlines.push({
      kind: "assigned-practice",
      title: set.inProgress
        ? `Finish the practice on ${set.conceptName}`
        : `Practise ${set.conceptName}`,
      why: [
        `Your ${set.className} teacher asked for ${set.questionCount} questions.`,
        overdue
          ? "It was asked for earlier — it still counts."
          : when
            ? `Asked for by ${when}.`
            : null,
        "No clock, and feedback after every question.",
      ]
        .filter(Boolean)
        .join(" "),
      href: `/student/practice?assigned=${set.id}`,
      actionLabel: set.inProgress ? "Carry on" : "Start",
      conceptId: set.conceptId,
      deadline: true,
    });
  }
  // --- 2. A paper open and not yet started ---------------------------------
  //
  // NOT YET STARTED, meaning no sitting at all. A second attempt the teacher
  // allows is an option the student can see on Home, not a deadline — listing
  // it as "Sit … DUE" after they have sat it tells them the paper they just
  // handed in did not count.
  for (const test of input.tests) {
    if (test.status !== "OPEN" || !test.canStart) continue;
    if (test.inProgressAttemptId !== null) continue;
    if (test.attemptsUsed > 0) continue;
    deadlines.push({
      kind: "sit-test",
      title: `Sit ${test.title}`,
      why: `${test.subjectName}. ${shutsSentence(test.closesAt, now)}`,
      // Home, at the paper's card — where the Start button is. Starting mints
      // its idempotency key on the device, so there is no page a link could
      // start a paper from; `/student/tests/…` was a route that never existed.
      href: `/student#test-${test.assignmentId}`,
      actionLabel: "Start",
      conceptId: null,
      deadline: true,
    });
  }

  // --- 3. Revise for a paper that is coming --------------------------------
  //
  // Only when there is something specific to say. "Revise for your test" is
  // advice that needed no database, and a plan full of it is one a student
  // stops reading.
  const revisedConceptIds = new Set<string>();
  for (const test of input.tests) {
    if (test.status !== "SCHEDULED") continue;
    const days = daysUntil(test.opensAt, now);
    if (days < 0 || days > REVISE_WINDOW_DAYS) continue;

    const weakest = weakestInSubject(input.concepts, test.subjectName);
    if (!weakest || weakest.estimate === null) continue;
    // Nothing to open. Naming a concept and then handing them an empty set is
    // worse than saying nothing, because they have already spent the tap.
    if (weakest.available < 4) continue;

    revisedConceptIds.add(weakest.conceptId);
    deadlines.push({
      kind: "revise-for-test",
      title: `Revise ${weakest.conceptName} before ${test.title}`,
      why:
        `Your ${test.subjectName} test opens ${whenPhrase(test.opensAt, now) ?? "soon"}, and ` +
        `${weakest.conceptName} is the ${test.subjectName} idea you are weakest on — ` +
        `about ${Math.round(weakest.estimate * 100)}% right so far.`,
      href: `/student/practice?conceptId=${weakest.conceptId}`,
      actionLabel: "Practise it",
      conceptId: weakest.conceptId,
      deadline: true,
    });
  }

  // --- 4. Questions they got wrong and have not fixed ----------------------
  //
  // One item, not one per concept. The bank is already a list; a plan that
  // reproduces it is two lists.
  if (input.openMistakes > 0) {
    discretionary.push({
      kind: "fix-mistakes",
      title:
        input.openMistakes === 1
          ? "Fix the question you got wrong"
          : `Fix ${input.openMistakes} questions you got wrong`,
      why: mistakesWhy(input.openMistakes, input.mistakeConceptName ?? null),
      href: "/student/mistakes",
      actionLabel: "Open the list",
      conceptId: null,
      deadline: false,
    });
  }

  // --- 5. Practice, from the recommender ------------------------------------
  //
  // Reusing `recommend` rather than re-deriving: two functions that both decide
  // what a student is weak at, disagreeing, is worse than either alone.
  const candidates = recommend(input.concepts, now).filter(
    (candidate) =>
      // "Solid — here if you want to keep it that way" is an offer, not a plan
      // item. A plan is what you should do; maintenance belongs on the practice
      // page where it can be ignored without ignoring the plan.
      candidate.reason !== "keep-sharp" &&
      // Already named above. The same concept under two headings is the page
      // arguing with itself.
      !revisedConceptIds.has(candidate.conceptId) &&
      // The mistakes item already covers this, in one line rather than three.
      candidate.reason !== "mistakes",
  );

  for (const candidate of candidates.slice(0, MAX_PRACTICE_ITEMS)) {
    discretionary.push({
      kind: "practise",
      title: `Practise ${candidate.conceptName}`,
      why: candidate.rationale,
      href: `/student/practice?conceptId=${candidate.conceptId}`,
      actionLabel: "Start a set",
      conceptId: candidate.conceptId,
      deadline: false,
    });
  }

  // --- Assemble --------------------------------------------------------------
  const room = Math.max(0, MAX_ITEMS - deadlines.length);
  const items = [...deadlines, ...discretionary.slice(0, room)];

  if (items.length > 0) return { ok: true, items };

  // Nothing to say, and the two ways of having nothing to say are opposites.
  const measured = input.concepts.some((concept) => concept.estimate !== null);
  if (!measured) {
    return {
      ok: false,
      reason: "nothing-yet",
      message:
        "There is nothing here yet. Once you have sat a test, this page will tell you what to work on and in what order.",
    };
  }
  return {
    ok: false,
    reason: "all-clear",
    message:
      "Nothing needs working on right now. You have no tests due, nothing outstanding to fix, and everything measured is holding up.",
  };
}

/**
 * Why the mistakes item is here.
 *
 * Names the dominant concept when there is one. "Five questions to fix" is a
 * chore; "five questions to fix, mostly about ratio" is a diagnosis, and only
 * one of them tells a student what they are actually going to be doing.
 */
function mistakesWhy(count: number, conceptName: string | null): string {
  const opening =
    count === 1
      ? "You got one question wrong and have not been back to it."
      : `You have ${count} questions you got wrong and have not been back to.`;
  const about =
    conceptName === null
      ? ""
      : count === 1
        ? ` It is about ${conceptName}.`
        : ` Most of them are about ${conceptName}.`;
  return `${opening}${about} They are the most specific thing anyone knows about what to work on.`;
}

/**
 * The weakest measured concept in one subject.
 *
 * Measured only — an unmeasured concept is not known to be weak, and telling a
 * student to revise it before a test on the strength of no evidence is the
 * guess this product refuses everywhere else.
 */
function weakestInSubject(
  concepts: PlanConcept[],
  subjectName: string,
): PlanConcept | null {
  let weakest: PlanConcept | null = null;
  for (const concept of concepts) {
    if (!concept.subjectNames.includes(subjectName)) continue;
    if (concept.estimate === null) continue;
    // Above the line is not a revision target. Sending somebody to practise
    // something they can already do, the night before a test, costs them the
    // evening they needed for something else.
    if (concept.estimate >= 0.6) continue;
    if (weakest === null || concept.estimate < weakest.estimate!) weakest = concept;
  }
  return weakest;
}

export type { Candidate };
