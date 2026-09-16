/**
 * The pure half of the student dashboard.
 *
 * Everything here decides something the home page then shows — whether a
 * comment is "new", what counts as this week, how a guardian's number is
 * masked, how a subject's concepts are counted — and none of it reads a
 * database. Same split as the plan, the recommender and the estimator: a rule
 * a student might argue with has to be testable without a server.
 */

import { MIN_SET, type ConceptState } from "@/core/practice/recommend";

// ---------------------------------------------------------------------------
// This week's effort
// ---------------------------------------------------------------------------

/**
 * How far back "this week" looks: a ROLLING seven days, not a calendar week.
 *
 * A calendar week resets to nothing every Monday morning, and a card that
 * reads "0 sets" at 00:01 on Monday is a streak counter in all but name — it
 * tells a student who worked all weekend that they have done nothing. Rolling
 * seven days never punishes the day of the week somebody happens to look, and
 * the label on the card says "last 7 days" so the number is not mistaken for
 * the other thing.
 */
export const EFFORT_DAYS = 7;

export function effortSince(now: Date): Date {
  return new Date(now.getTime() - EFFORT_DAYS * 86_400_000);
}

/**
 * Whole calendar days between two moments, in India. 0 is today.
 *
 * By calendar day and pinned to Asia/Kolkata, for the reason the plan's
 * `whenPhrase` is: an announcement posted at 23:50 is "yesterday" at 00:10,
 * and a server on UTC would call it "today" for five and a half more hours.
 * A moment in the future (a clock skewed between two machines) is today, not
 * "in 1 day".
 */
export function kolkataDaysAgo(date: Date, now: Date): number {
  return Math.max(0, kolkataDay(now) - kolkataDay(date));
}

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

// ---------------------------------------------------------------------------
// Teacher feedback
// ---------------------------------------------------------------------------

/**
 * Whether a teacher has said something the student has not looked at since.
 *
 * "Since" is the point. `feedbackSeenAt` is stamped when the student opens the
 * result, and a comment the teacher wrote — or rewrote — after that is new
 * again. A comment with no `gradedAt` cannot be dated, so it counts as new
 * only while the student has never opened the result at all: better one
 * extra prompt than a teacher's comment nobody is ever told about.
 *
 * Takes WHEN each comment was written, not the comments. Deciding whether one
 * is new does not need its words, so the read model never fetches them for
 * this — they reach the page only through the result's own review gate.
 */
export function hasNewFeedback(
  commentedAt: (Date | null)[],
  seenAt: Date | null,
): boolean {
  if (commentedAt.length === 0) return false;
  if (seenAt === null) return true;
  return commentedAt.some(
    (gradedAt) => gradedAt !== null && gradedAt.getTime() > seenAt.getTime(),
  );
}

// ---------------------------------------------------------------------------
// Who can see my progress
// ---------------------------------------------------------------------------

/**
 * "98•••••210" — enough for a student to recognise their mother's number, not
 * enough to be a disclosure on a screen a classmate is looking over.
 *
 * Masked on the server, before the number is put in anything: a full number
 * that reaches a component "just to be masked there" is a full number in the
 * page payload. Anything that is not a ten-digit Indian mobile after stripping
 * punctuation is returned as null rather than half-masked — a mask built over
 * a malformed value can reveal most of it.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return null;
  return `${digits.slice(0, 2)}•••••${digits.slice(-3)}`;
}

// ---------------------------------------------------------------------------
// My concepts, per subject
// ---------------------------------------------------------------------------

export type SubjectSnapshot = {
  subjectName: string;
  /** Counts only. There is no overall figure and no percentage here. */
  secure: number;
  almostThere: number;
  needsPractice: number;
  notEnoughEvidence: number;
  /**
   * The weakest MEASURED concept that is not already secure, by name.
   *
   * Null when nothing in the subject is measured, or when everything measured
   * is secure — an unmeasured concept is not known to be weak, and naming one
   * would be the guess the estimator refuses to make.
   */
  weakest: {
    conceptId: string;
    conceptName: string;
    /**
     * Whether a set can actually be opened. A "Practise it" link onto an empty
     * bank has already spent the tap, which is the plan's rule too.
     */
    canPractise: boolean;
  } | null;
};

/**
 * Band counts per subject, weakest concept named.
 *
 * Built from `studentConceptStates` — the same rows the practice page and the
 * plan read — so the three cannot disagree about which concept is weak. A
 * concept taught in two subjects counts in both, because it is in both
 * syllabuses; the counts are per subject, never summed across them.
 *
 * Subjects are sorted by name. A dashboard whose cards reshuffle between two
 * page loads is one nobody can compare with yesterday.
 */
export function conceptSnapshot(
  concepts: (ConceptState & { subjectNames: string[] })[],
): SubjectSnapshot[] {
  const bySubject = new Map<string, SubjectSnapshot>();
  const weakestEstimate = new Map<string, number>();

  for (const concept of concepts) {
    const subjects = concept.subjectNames.length > 0 ? concept.subjectNames : ["Other"];
    for (const subjectName of subjects) {
      const row =
        bySubject.get(subjectName) ??
        {
          subjectName,
          secure: 0,
          almostThere: 0,
          needsPractice: 0,
          notEnoughEvidence: 0,
          weakest: null,
        };

      // INSUFFICIENT first, and on the estimate as well as the band: a row
      // with a null estimate contributes to nothing but this count, whatever
      // its band column says.
      if (concept.band === "INSUFFICIENT" || concept.estimate === null) {
        row.notEnoughEvidence++;
      } else if (concept.band === "SECURE") {
        row.secure++;
      } else if (concept.band === "DEVELOPING") {
        row.almostThere++;
      } else {
        row.needsPractice++;
      }

      if (concept.estimate !== null && concept.band !== "INSUFFICIENT" && concept.band !== "SECURE") {
        const current = weakestEstimate.get(subjectName);
        if (current === undefined || concept.estimate < current) {
          weakestEstimate.set(subjectName, concept.estimate);
          row.weakest = {
            conceptId: concept.conceptId,
            conceptName: concept.conceptName,
            canPractise: concept.available >= MIN_SET,
          };
        }
      }

      bySubject.set(subjectName, row);
    }
  }

  return [...bySubject.values()].sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

// ---------------------------------------------------------------------------
// The latest result, in one line
// ---------------------------------------------------------------------------

export type ResultMarks =
  /** Everything decided: "7 / 10". */
  | { kind: "final"; awarded: number; total: number }
  /** Some marks still with the teacher. `awarded` is what is decided so far. */
  | { kind: "so-far"; awarded: number; total: number; pending: number }
  /** Nothing has a mark yet. Never printed as "0 / 10". */
  | { kind: "unmarked"; total: number; pending: number };

/**
 * What the headline number on the latest-result card may say.
 *
 * Null is not zero, and this is where a dashboard is most tempted to forget
 * it: a paper whose only answer is a written one waiting on a teacher has a
 * raw score of 0 in the result payload, and "0 / 5" on a home page reads as
 * a failed test rather than an unread one.
 */
export function resultMarks(result: {
  rawScore: number;
  maxScore: number;
  pendingMarks: number;
  breakdown: { awardedMarks: number | null }[];
}): ResultMarks {
  // `rawScore` arrives as 0 when the column is null, so it cannot be trusted to
  // say whether anything was marked; the per-question marks can.
  if (result.pendingMarks <= 0) {
    return { kind: "final", awarded: result.rawScore, total: result.maxScore };
  }
  const anythingMarked = result.breakdown.some((item) => item.awardedMarks !== null);
  if (!anythingMarked) {
    return { kind: "unmarked", total: result.maxScore, pending: result.pendingMarks };
  }
  return {
    kind: "so-far",
    awarded: result.rawScore,
    total: result.maxScore,
    pending: result.pendingMarks,
  };
}

/**
 * Questions worth opening again: marked, and short of full marks.
 *
 * An unmarked answer is not one to review — there is nothing to review yet —
 * and a blank is included, because leaving it blank is exactly the kind of
 * question the review exists for. A blank scores null just as an unmarked
 * answer does, so `answered` is what tells the two apart, the same way the
 * result page's own states do.
 */
export function questionsToReview(
  breakdown: { awardedMarks: number | null; marks: number; answered: boolean }[],
): number {
  return breakdown.filter((item) =>
    item.awardedMarks === null ? !item.answered : item.awardedMarks < item.marks,
  ).length;
}
