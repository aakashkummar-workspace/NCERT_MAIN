/**
 * What a term report is allowed to say.
 *
 * Pure, and this one matters more than most: a report is the artefact that
 * leaves the building. A teacher hands it across a desk, a parent keeps it, and
 * both of them will still be quoting it in three months. Everything else in
 * this product can be corrected by refreshing a page. This cannot.
 *
 * ---------------------------------------------------------------------------
 * There is no overall grade, and there will not be one
 * ---------------------------------------------------------------------------
 * It is the first thing anybody asks for and it is the one number that must not
 * exist. Averaging mastery across concepts produces a figure that moves when
 * the syllabus moves, invites ranking children against each other, and hides
 * the only thing a parent can act on — WHICH idea. The teacher's analytics
 * refuses it, the students index refuses it, and a report is where the pressure
 * to add it is strongest, because a report looks like a report card.
 *
 * So the report carries band counts, named concepts, and every denominator.
 *
 * ---------------------------------------------------------------------------
 * Coverage comes first, and it is usually the honest headline
 * ---------------------------------------------------------------------------
 * "Secure on 2 of 5 ideas we have measured" and "secure on 2 of the 40 ideas in
 * the syllabus" are wildly different statements about a child, and only one of
 * them is true. A report that leads with performance and buries coverage lets a
 * parent read a term's worth of confidence into four questions.
 *
 * So `measured` and `unmeasured` are both on the page, above the marks, and a
 * report over too little evidence refuses to be generated at all rather than
 * being generated thin. A thin report is worse than none: it is a document,
 * with a date on it, that somebody will act on.
 */

export type Band = "CRITICAL" | "FRAGILE" | "DEVELOPING" | "SECURE" | "INSUFFICIENT";

export type ReportConcept = {
  conceptId: string;
  conceptName: string;
  /** Null whenever the band is INSUFFICIENT. Never rendered as zero. */
  estimate: number | null;
  band: Band;
  /** Answers behind the estimate, so a reader can weigh it. */
  evidenceCount: number;
};

export type ReportSitting = {
  assignmentId: string;
  title: string;
  subjectName: string;
  satAt: Date;
  /**
   * How many times they sat this paper.
   *
   * One row per PAPER, not per attempt. A student who used four of five
   * attempts produced four rows reading the same title and the same date,
   * which on a document handed to a parent looks like a fault in the product
   * and overstates how much testing happened. A screenshot caught it.
   */
  attempts: number;
  /**
   * Null when the teacher has not released the marks.
   *
   * An unreleased mark stays out of the report entirely rather than appearing
   * as a blank row — a parent reading the report before their child has seen
   * the score is the ambush the release gate exists to prevent.
   */
  percentage: number | null;
  awarded: number | null;
  total: number | null;
  /** Papers still partly with the teacher. Named, never averaged away. */
  fullyMarked: boolean;
};

export type ReportInput = {
  studentName: string;
  className: string | null;
  periodStart: Date;
  periodEnd: Date;
  concepts: ReportConcept[];
  /** Concepts in this student's subjects that nothing has measured yet. */
  unmeasuredCount: number;
  sittings: ReportSitting[];
  /**
   * The same concept estimates as at the START of the period, by concept id.
   *
   * Improvement is the thing a parent actually wants and the thing this product
   * is uniquely able to say. It is only claimed where BOTH readings exist —
   * "improved from nothing" is not improvement, it is a first measurement.
   */
  openingEstimates: Map<string, number>;
};

/**
 * Below this a report refuses to exist.
 *
 * The same bar as the class read and the parent view, applied where it matters
 * most. Three measured concepts is not a term's work, and a document dated and
 * handed over says otherwise however carefully it is worded.
 */
export const MIN_MEASURED_FOR_REPORT = 3;

/** A movement smaller than this is noise, and naming it as progress is a lie. */
export const MIN_MOVEMENT = 0.1;

export type Movement = {
  conceptId: string;
  conceptName: string;
  from: number;
  to: number;
};

export type ReportPayload = {
  studentName: string;
  className: string | null;
  periodStart: string;
  periodEnd: string;

  /**
   * How much of what exists has been looked at. The headline.
   *
   * Two integers and no ratio. The ratio is derivable from them, and a stored
   * document should hold facts rather than presentation — but the reason it
   * came OUT was sharper than that: `payload` is a jsonb column, Postgres
   * stores its numbers as `numeric`, and a double does not necessarily come
   * back bit-identical. 0.011538461538461539 went in and
   * 0.01153846153846154 came out, which made a stamped report differ from
   * itself on re-read. A derived float in a document that must never change is
   * a bug waiting for a denominator with a long expansion.
   */
  coverage: {
    measured: number;
    unmeasured: number;
  };

  /** Band counts over the measured concepts. Never a single score. */
  standing: {
    secure: number;
    developing: number;
    needsWork: number;
  };

  strengths: ReportConcept[];
  attention: ReportConcept[];

  /** Concepts that moved, in both directions. Only where both readings exist. */
  improved: Movement[];
  slipped: Movement[];

  sittings: ReportSitting[];
  /** Papers in the period still partly unmarked. Stated, never hidden. */
  awaitingMarking: number;

  /** Two or three sentences, built from the numbers above. Never a model's. */
  summary: string;
  /** What to do, in plain words. At most three. */
  suggestions: string[];
};

export type BuildResult =
  | { ok: true; payload: ReportPayload }
  | { ok: false; reason: "not-enough-measured"; message: string };

/** How many concepts to name on each side. A list of twenty is not a report. */
const NAMED = 3;

const SECURE_AT = 0.8;
const NEEDS_WORK_BELOW = 0.6;

export function buildReport(input: ReportInput): BuildResult {
  const measured = input.concepts.filter(
    (concept) => concept.estimate !== null && concept.band !== "INSUFFICIENT",
  );

  if (measured.length < MIN_MEASURED_FOR_REPORT) {
    return {
      ok: false,
      reason: "not-enough-measured",
      message:
        measured.length === 0
          ? "There is nothing measured for this student in this period, so there is nothing a report could honestly say. Set a test first."
          : `Only ${measured.length} ${measured.length === 1 ? "idea has" : "ideas have"} enough evidence in this period. A report needs at least ${MIN_MEASURED_FOR_REPORT}, because a document with a date on it will be acted on.`,
    };
  }

  const secure = measured.filter((c) => c.estimate! >= SECURE_AT);
  const needsWork = measured.filter((c) => c.estimate! < NEEDS_WORK_BELOW);
  const developing = measured.filter(
    (c) => c.estimate! >= NEEDS_WORK_BELOW && c.estimate! < SECURE_AT,
  );

  const byStrongest = [...measured].sort((a, b) => b.estimate! - a.estimate!);
  const needsWorkIds = new Set(needsWork.map((c) => c.conceptId));

  // A concept must never appear under both headings. It did once, on the parent
  // portal, with one measured concept listed as both the strongest and the
  // weakest — badge and all.
  const strengths = byStrongest
    .filter((c) => !needsWorkIds.has(c.conceptId))
    .slice(0, NAMED);
  const attention = [...needsWork]
    .sort((a, b) => a.estimate! - b.estimate!)
    .slice(0, NAMED);

  const improved: Movement[] = [];
  const slipped: Movement[] = [];
  for (const concept of measured) {
    const from = input.openingEstimates.get(concept.conceptId);
    // Only where BOTH readings exist. "Improved from nothing" is not
    // improvement, it is a first measurement, and claiming it as progress is
    // the most flattering lie this report could tell.
    if (from === undefined) continue;
    const delta = concept.estimate! - from;
    if (delta >= MIN_MOVEMENT) {
      improved.push({
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        from,
        to: concept.estimate!,
      });
    } else if (delta <= -MIN_MOVEMENT) {
      slipped.push({
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        from,
        to: concept.estimate!,
      });
    }
  }
  improved.sort((a, b) => b.to - b.from - (a.to - a.from));
  slipped.sort((a, b) => a.to - a.from - (b.to - b.from));

  // Released papers only. An unreleased mark in a report reaches a parent
  // before it reaches the child, which is the ambush the release gate exists
  // to prevent.
  const released = input.sittings.filter((s) => s.percentage !== null);
  const awaitingMarking = input.sittings.filter((s) => !s.fullyMarked).length;

  return {
    ok: true,
    payload: {
      studentName: input.studentName,
      className: input.className,
      periodStart: input.periodStart.toISOString(),
      periodEnd: input.periodEnd.toISOString(),
      coverage: {
        measured: measured.length,
        unmeasured: input.unmeasuredCount,
      },
      standing: {
        secure: secure.length,
        developing: developing.length,
        needsWork: needsWork.length,
      },
      strengths,
      attention,
      improved,
      slipped,
      sittings: released,
      awaitingMarking,
      summary: writeSummary({
        studentName: input.studentName,
        measured: measured.length,
        unmeasured: input.unmeasuredCount,
        secure: secure.length,
        needsWork: needsWork.length,
        improved,
        slipped,
        sittings: released.length,
        awaitingMarking,
      }),
      suggestions: writeSuggestions(attention, improved, input.unmeasuredCount),
    },
  };
}

/**
 * The summary, assembled from the figures rather than written by a model.
 *
 * A model could phrase this more warmly and would occasionally phrase it
 * wrongly, and a warmly-worded wrong sentence about somebody's child, on a
 * document they keep, is the worst output this product could produce. There is
 * no AI anywhere in a report for that reason. The tone is deliberately plain:
 * a parent reading about their child does not need encouragement written into
 * the arithmetic, they need to know where things stand.
 */
function writeSummary(input: {
  studentName: string;
  measured: number;
  unmeasured: number;
  secure: number;
  needsWork: number;
  improved: Movement[];
  slipped: Movement[];
  sittings: number;
  awaitingMarking: number;
}): string {
  const first = input.studentName.split(/\s+/)[0] ?? input.studentName;
  const parts: string[] = [];

  // Coverage first, always. The denominator is the context for everything else.
  parts.push(
    input.unmeasured === 0
      ? `Over this period we measured ${first} on ${input.measured} ${input.measured === 1 ? "idea" : "ideas"}.`
      : `Over this period we measured ${first} on ${input.measured} of the ${input.measured + input.unmeasured} ideas in these subjects. The other ${input.unmeasured} have not been tested yet, so this report says nothing about them.`,
  );

  parts.push(
    input.needsWork === 0
      ? `Of those, ${input.secure} ${input.secure === 1 ? "is" : "are"} secure and none is below the line.`
      : `Of those, ${input.secure} ${input.secure === 1 ? "is" : "are"} secure and ${input.needsWork} ${input.needsWork === 1 ? "needs" : "need"} work.`,
  );

  if (input.improved.length > 0) {
    const names = input.improved.slice(0, 2).map((m) => m.conceptName).join(" and ");
    parts.push(`${first} has improved on ${names} since the start of the period.`);
  }
  if (input.slipped.length > 0) {
    const names = input.slipped.slice(0, 2).map((m) => m.conceptName).join(" and ");
    parts.push(`${names} ${input.slipped.length === 1 ? "has" : "have"} gone the other way.`);
  }

  if (input.awaitingMarking > 0) {
    // Said out loud. A figure computed over fully marked papers, presented
    // without the count left out, is a wrong figure rather than a smaller one.
    parts.push(
      `${input.awaitingMarking} ${input.awaitingMarking === 1 ? "paper is" : "papers are"} still being marked and ${input.awaitingMarking === 1 ? "is" : "are"} not counted here.`,
    );
  }

  return parts.join(" ");
}

/**
 * What to do, in plain words.
 *
 * Addressed to whoever is reading — a parent, usually — and never a
 * reprimand. Three at most: a list of eight is a list nobody starts, and a
 * parent handed eight instructions does none of them.
 */
function writeSuggestions(
  attention: ReportConcept[],
  improved: Movement[],
  unmeasured: number,
): string[] {
  const out: string[] = [];

  for (const [index, concept] of attention.slice(0, 2).entries()) {
    const figure = `about ${Math.round(concept.estimate! * 100)}% over ${concept.evidenceCount} ${concept.evidenceCount === 1 ? "answer" : "answers"}`;
    // Only the first can be the one that would gain the most. Two sentences
    // both claiming the superlative is the kind of thing nobody notices in
    // code and everybody notices on a sheet they are handed.
    out.push(
      index === 0
        ? `Spend time on ${concept.conceptName}. It is at ${figure}, and it is the one that would gain the most.`
        : `${concept.conceptName} is next, at ${figure}.`,
    );
  }

  if (out.length === 0 && improved.length > 0) {
    out.push(
      `Nothing here needs fixing. ${improved[0]!.conceptName} has come up this period — worth saying so.`,
    );
  }

  if (unmeasured > 0 && out.length < 3) {
    // The honest caveat, phrased as a next step rather than an apology.
    out.push(
      `${unmeasured} ${unmeasured === 1 ? "idea has" : "ideas have"} not been tested yet. Ask the teacher what is coming, rather than reading this report as covering the whole subject.`,
    );
  }

  return out.slice(0, 3);
}
