import type { Band, ReportConcept, ReportInput } from "./build";
import { MIN_MOVEMENT } from "./build";

/**
 * The parent–teacher meeting brief: one page per child, for the teacher to
 * hold while a parent sits across the table.
 *
 * Pure, so every sentence can be traced to the numbers it came from.
 *
 * ---------------------------------------------------------------------------
 * Not a report, and the difference is deliberate
 * ---------------------------------------------------------------------------
 * A term report is STAMPED because it is handed over and kept. This is the
 * teacher's crib for a ten-minute conversation, so it is derived when opened
 * and stored nowhere — the study plan's rule, for the plan's reason: a brief
 * printed on Friday for Saturday's meeting should say what is true on Friday.
 *
 * It still follows every rule a report does, because a parent may read it
 * upside down across the table: no overall score, no rank, band counts with
 * their denominator, unreleased marks absent, a thin picture said to be thin.
 * And it does NOT refuse below three measured concepts, as a report does —
 * the meeting happens anyway, and "we have measured very little so far" is
 * the most useful thing a teacher can say in it.
 *
 * No model: a warmly worded wrong sentence about somebody's child, said to
 * their parent, is the worst output this product could produce.
 */

export type MeetingExtras = {
  /** Mistake Bank: still open, and closed within the period. */
  openMistakes: number;
  resolvedMistakes: number;
  /** Practice sets finished in the period, and teacher-set ones outstanding. */
  practiceDone: number;
  assignedOutstanding: number;
  /** Where the weakest ideas are in the book, by concept id. */
  bookLines: Map<string, string>;
};

export type MeetingBrief = {
  studentName: string;
  className: string | null;
  periodStart: string;
  periodEnd: string;
  coverage: { measured: number; unmeasured: number };
  standing: { secure: number; developing: number; needsWork: number };
  goingWell: { name: string; band: Band }[];
  needsWork: { name: string; band: Band; percent: number | null; book: string | null }[];
  improved: { name: string; from: number; to: number }[];
  slipped: { name: string; from: number; to: number }[];
  papers: { title: string; subjectName: string; satAt: string; result: string }[];
  awaitingMarking: number;
  /** What to say, in order. Built from the figures above; at most five. */
  talkingPoints: string[];
  /** What the family can do at home. At most three. */
  atHome: string[];
};

const NEEDS_WORK: Band[] = ["CRITICAL", "FRAGILE"];

export function buildMeetingBrief(input: ReportInput, extras: MeetingExtras): MeetingBrief {
  const measured = input.concepts.filter((concept) => concept.band !== "INSUFFICIENT");
  const secure = measured.filter((concept) => concept.band === "SECURE");
  const developing = measured.filter((concept) => concept.band === "DEVELOPING");
  const weak = measured
    .filter((concept) => NEEDS_WORK.includes(concept.band))
    .sort((a, b) => (a.estimate ?? 0) - (b.estimate ?? 0));

  const movement = measured.flatMap((concept) => {
    const from = input.openingEstimates.get(concept.conceptId);
    if (from === undefined || concept.estimate === null) return [];
    return [{ name: concept.conceptName, from, to: concept.estimate }];
  });
  const improved = movement.filter((m) => m.to - m.from >= MIN_MOVEMENT).sort((a, b) => b.to - b.from - (a.to - a.from));
  const slipped = movement.filter((m) => m.from - m.to >= MIN_MOVEMENT).sort((a, b) => a.to - a.from - (b.to - b.from));

  // `gather` leaves unreleased papers out entirely, as a report must.
  const released = input.sittings;
  const awaitingMarking = input.sittings.filter((sitting) => !sitting.fullyMarked).length;

  const total = measured.length + input.unmeasuredCount;
  const topWeak = weak.slice(0, 3);
  const talkingPoints: string[] = [];

  if (measured.length < 3) {
    talkingPoints.push(
      `We have measured ${measured.length} of the ${total} ideas in ${firstName(input.studentName)}'s subjects so far, so this is an early picture — too little to judge by.`,
    );
  } else {
    talkingPoints.push(
      `We have measured ${measured.length} of the ${total} ideas so far: secure on ${secure.length}, getting there on ${developing.length}, and ${weak.length} that need work.`,
    );
  }
  if (secure.length > 0) {
    talkingPoints.push(`Going well: ${listNames(secure.slice(0, 3))}.`);
  }
  if (topWeak.length > 0) {
    talkingPoints.push(`To work on: ${listNames(topWeak)}.`);
  }
  if (improved.length > 0) {
    talkingPoints.push(`Improved this period on ${improved.slice(0, 2).map((m) => m.name).join(" and ")}.`);
  }
  if (slipped.length > 0) {
    talkingPoints.push(`Slipped on ${slipped.slice(0, 2).map((m) => m.name).join(" and ")} — worth asking about.`);
  }
  if (extras.openMistakes > 0) {
    talkingPoints.push(
      `${extras.openMistakes} wrong ${extras.openMistakes === 1 ? "answer is" : "answers are"} still to fix in their "Things to fix" list${extras.resolvedMistakes > 0 ? `; ${extras.resolvedMistakes} fixed this period` : ""}.`,
    );
  }
  if (extras.practiceDone > 0) {
    talkingPoints.push(`Finished ${extras.practiceDone} practice ${extras.practiceDone === 1 ? "set" : "sets"} this period.`);
  }
  if (awaitingMarking > 0) {
    talkingPoints.push(`${awaitingMarking} ${awaitingMarking === 1 ? "paper is" : "papers are"} still being marked, so the picture will change.`);
  }

  const atHome: string[] = [];
  for (const concept of topWeak.slice(0, 2)) {
    const book = extras.bookLines.get(concept.conceptId);
    atHome.push(
      book
        ? `Go over ${concept.conceptName} together: ${book}.`
        : `Go over ${concept.conceptName} together, from the textbook chapter.`,
    );
  }
  if (extras.assignedOutstanding > 0) {
    atHome.push(
      `${extras.assignedOutstanding} practice ${extras.assignedOutstanding === 1 ? "set is" : "sets are"} waiting on their Home page — ten minutes each, no marks.`,
    );
  } else if (topWeak.length > 0) {
    atHome.push("A short practice set on the Home page, a few evenings a week, moves these fastest.");
  }

  return {
    studentName: input.studentName,
    className: input.className,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    coverage: { measured: measured.length, unmeasured: input.unmeasuredCount },
    standing: { secure: secure.length, developing: developing.length, needsWork: weak.length },
    goingWell: secure.slice(0, 5).map((concept) => ({ name: concept.conceptName, band: concept.band })),
    needsWork: weak.slice(0, 5).map((concept) => ({
      name: concept.conceptName,
      band: concept.band,
      percent: concept.estimate === null ? null : Math.round(concept.estimate * 100),
      book: extras.bookLines.get(concept.conceptId) ?? null,
    })),
    improved: improved.slice(0, 3),
    slipped: slipped.slice(0, 3),
    papers: released.map((sitting) => ({
      title: sitting.title,
      subjectName: sitting.subjectName,
      satAt: sitting.satAt.toISOString(),
      result:
        sitting.awarded !== null && sitting.total !== null
          ? `${sitting.awarded} of ${sitting.total}${sitting.fullyMarked ? "" : " (part marked)"}`
          : "Not released yet",
    })),
    awaitingMarking,
    talkingPoints: talkingPoints.slice(0, 5),
    atHome: atHome.slice(0, 3),
  };
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

function listNames(concepts: ReportConcept[]): string {
  const names = concepts.map((concept) => concept.conceptName);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
