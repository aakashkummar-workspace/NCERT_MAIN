/**
 * Exam readiness, as a picture rather than a score.
 *
 * Pure, for the same reason the mastery estimator, the recommender and the
 * plan are: this is the page a fifteen-year-old opens at eleven at night three
 * weeks before their boards, and whatever it says they will believe. A claim
 * that size has to be re-derivable from the stored evidence, by somebody who
 * was not in the room, months later — which a function that reads a database
 * cannot be.
 *
 * ---------------------------------------------------------------------------
 * There is no readiness score, and there will not be one
 * ---------------------------------------------------------------------------
 * It is the first thing anybody asks for — "just give them a percentage" — and
 * it is the one number that must not exist. It is the same composite this
 * product already refuses in four places, wearing a new label:
 *
 *   - the students index refuses an overall score per student,
 *   - class analytics refuses a single "class mastery",
 *   - a term report refuses an overall grade,
 *   - and the institute console refuses to rank teachers at all.
 *
 * Every argument they make applies here and harder. A readiness figure would be
 * an average over concepts, so it would move when the syllabus moved rather
 * than when the student did; it would be dominated by whichever chapters the
 * teacher happened to test; it would invite a class of children to compare
 * theirs; and it would hide the only thing anybody can act on — WHICH idea, and
 * WHICH chapter nobody has looked at.
 *
 * So the type has no field for it. Not "we do not render it" — no field, so a
 * component that wanted one would not compile, which is the only version of
 * this rule that survives the afternoon somebody is asked for a number.
 *
 * ---------------------------------------------------------------------------
 * Coverage first, because it is usually the whole answer
 * ---------------------------------------------------------------------------
 * "Secure on 4 of the 6 ideas we have measured" and "secure on 4 of the 380
 * ideas in the syllabus" describe wildly different students, and a page that
 * leads with performance lets somebody read a year's confidence into two
 * papers. So every figure below carries its denominator, and the chapter
 * counts come before the concept counts — a chapter nobody has tested is the
 * gap a student can actually do something about.
 *
 * ---------------------------------------------------------------------------
 * And it refuses, loudly, which is the common case
 * ---------------------------------------------------------------------------
 * Below the thresholds this returns `ok: false` and says the honest thing:
 * *we have measured 3 of the 51 chapters in your syllabus, and that is not
 * enough to tell you whether you are ready*. That is not a degraded answer to
 * be apologised for — it is the correct one, and it is what the page will say
 * for most students for most of a year. The alternative is a confident picture
 * built out of one paper, which is how a student revises the wrong chapter.
 *
 * The refusal still carries the coverage figures and the untested chapters,
 * because those are facts that need no threshold: "no test you have sat has
 * asked about chapter 9" is true over any amount of evidence, and it is the
 * most useful sentence on the page. What the refusal withholds is the standing
 * — the band counts — and it withholds them STRUCTURALLY, by not having the
 * field, so nothing can put "2 secure" beside "3 of 51 chapters" and let a
 * reader draw the obvious wrong conclusion.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is stored
 * ---------------------------------------------------------------------------
 * Same rule as the study plan and as an assignment's status: derived at read
 * time, from evidence, every time. A stored readiness picture is stale the
 * moment a paper is marked, would need a job to refresh it, and between ticks
 * would be a row that is a lie — shown to a student deciding what to revise
 * tonight. There is nothing to tick off and no route that changes any of it;
 * this page moves when the evidence moves and on nothing else.
 */

import { MIN_EVIDENCE } from "@/core/mastery/estimate";

export type ReadinessBand =
  | "CRITICAL"
  | "FRAGILE"
  | "DEVELOPING"
  | "SECURE"
  | "INSUFFICIENT";

export type ReadinessConcept = {
  conceptId: string;
  conceptName: string;
  band: ReadinessBand;
  /**
   * Null whenever the band is INSUFFICIENT, because the column is null.
   *
   * Nothing below is derived from an INSUFFICIENT row: not a count, not a
   * chapter's state, not a sentence. Null is not zero — "nobody has measured
   * this" and "they scored nothing" are opposite facts, and only one of them
   * is about the student.
   */
  estimate: number | null;
  /** Answers behind the estimate, so a student can weigh it. */
  evidenceCount: number;
};

/**
 * A concept the estimator stood behind.
 *
 * The same trick `Mastery` plays, applied one level up: on the picture there is
 * no INSUFFICIENT band and `estimate` is a number rather than `number | null`,
 * so a component rendering one of these cannot be rendering a figure the
 * product refused to produce. It is a type error rather than a rule somebody
 * has to remember on a busy afternoon.
 */
export type MeasuredConcept = {
  conceptId: string;
  conceptName: string;
  band: "CRITICAL" | "FRAGILE" | "DEVELOPING" | "SECURE";
  estimate: number;
  evidenceCount: number;
};

export type ReadinessChapter = {
  chapterId: string;
  subjectName: string;
  /** The chapter's number in the book, which is how a student refers to it. */
  number: number;
  title: string;
};

export type ReadinessInput = {
  /** The subjects this student is enrolled to sit. */
  subjectNames: string[];
  /**
   * Every concept in those subjects — the denominator.
   *
   * The honest one. Counting only what has been measured is the flattering
   * denominator that makes two answered questions look like a syllabus.
   */
  syllabusConceptIds: string[];
  /** What we believe about this student. Rows outside the syllabus are dropped. */
  concepts: ReadinessConcept[];
  /** Every chapter in those subjects, already in syllabus order. */
  chapters: ReadinessChapter[];
  /**
   * Chapters a paper this student actually SAT carried a question from.
   *
   * Deliberately not derived from the evidence ledger. An outcome with no
   * concept mapped to it produces no evidence at all — 64 of the 69 seeded
   * outcomes are in that state — so a chapter a student sat a whole paper on
   * would be listed as "never tested". A student knows that is false, and one
   * visibly wrong line is all it takes for them to stop reading the rest.
   */
  testedChapterIds: string[];
  /** Which chapters teach each concept, so a chapter can be called measured. */
  chaptersByConcept: Map<string, string[]>;
};

export type ReadinessCoverage = {
  /** Concepts with an estimate the estimator stood behind. */
  measuredConcepts: number;
  totalConcepts: number;
  /** Chapters with at least one measured concept. */
  measuredChapters: number;
  /** Chapters that have appeared on a paper they sat, measured or not. */
  testedChapters: number;
  totalChapters: number;
};

export type Readiness =
  | {
      ok: true;
      subjects: string[];
      coverage: ReadinessCoverage;
      /**
       * Counts over the measured concepts. Three integers, never an average
       * and never a ratio: the moment this becomes one number it is the
       * composite the whole module exists to refuse.
       */
      standing: { secure: number; developing: number; needsWork: number };
      /** Named, weakest first — "struggling" with what is the actionable half. */
      attention: MeasuredConcept[];
      /** Named too, so the page is not only a list of failures. */
      strengths: MeasuredConcept[];
      untested: ReadinessChapter[];
      /** Tested, but not enough answers on any idea in it to say anything. */
      thin: ReadinessChapter[];
      /** Assembled from the figures above. Never a model's sentence. */
      summary: string;
      /** What this picture does NOT cover. Null when it covers everything. */
      caveat: string | null;
    }
  | {
      ok: false;
      /**
       * Why there is no picture. Three situations and three sentences: "you
       * are not in a class", "nobody has measured anything about you yet" and
       * "we have measured a corner of the syllabus" are different facts, and
       * a page that shared a message between them would be answering a
       * question the student did not ask. The same three-refusals rule the
       * recommender follows.
       */
      reason: "no-syllabus" | "nothing-measured" | "too-thin";
      subjects: string[];
      coverage: ReadinessCoverage;
      /** Carried through the refusal: this needs no threshold to be true. */
      untested: ReadinessChapter[];
      thin: ReadinessChapter[];
      headline: string;
      message: string;
    };

/**
 * Concepts that must be measured before this page will draw a picture.
 *
 * Higher than the three a term report demands, and deliberately: a report
 * describes a period and says so on its face, while this is a claim about a
 * whole syllabus on the eve of an exam. The bigger the claim, the more it has
 * to be standing on.
 */
export const MIN_MEASURED_CONCEPTS = 5;

/**
 * And half the chapters, because the exam is over all of them.
 *
 * A fraction rather than a count, for the reason class-scope gap detection
 * needs one: seven chapters is most of a Class 9 subject and a fifth of a
 * board syllabus, and the same integer cannot mean both. Both bars have to
 * clear — measuring five concepts that all live in one chapter is a statement
 * about that chapter, and the student is not sitting that chapter.
 */
export const MIN_CHAPTER_FRACTION = 0.5;

/** How many measured chapters a syllabus of this size needs. */
export function chaptersNeeded(totalChapters: number): number {
  return Math.ceil(totalChapters * MIN_CHAPTER_FRACTION);
}

/**
 * How many concepts to name on each side.
 *
 * Five rather than the report's three, because this list is the student's own
 * and they are the one who has to act on it — but still capped, since a list
 * of forty is one nobody starts. The counts in `standing` carry the rest.
 */
const NAMED = 5;

export function buildReadiness(input: ReadinessInput): Readiness {
  const subjects = [...input.subjectNames];
  const inSyllabus = new Set(input.syllabusConceptIds);
  const tested = new Set(input.testedChapterIds);

  // The one filter everything downstream depends on. A row the estimator
  // refused to stand behind contributes to no count, no chapter state and no
  // sentence on this page — and a concept from a subject this student is no
  // longer sitting is not part of their syllabus, so counting it would move
  // the coverage figure for a reason nobody could explain.
  const measured: MeasuredConcept[] = [];
  for (const concept of input.concepts) {
    if (!inSyllabus.has(concept.conceptId)) continue;
    if (concept.band === "INSUFFICIENT" || concept.estimate === null) continue;
    measured.push({
      conceptId: concept.conceptId,
      conceptName: concept.conceptName,
      band: concept.band,
      estimate: concept.estimate,
      evidenceCount: concept.evidenceCount,
    });
  }

  const measuredChapterIds = new Set<string>();
  for (const concept of measured) {
    for (const chapterId of input.chaptersByConcept.get(concept.conceptId) ?? []) {
      measuredChapterIds.add(chapterId);
    }
  }

  const untested: ReadinessChapter[] = [];
  const thin: ReadinessChapter[] = [];
  let measuredChapters = 0;
  let testedChapters = 0;

  for (const chapter of input.chapters) {
    const isMeasured = measuredChapterIds.has(chapter.chapterId);
    const isTested = tested.has(chapter.chapterId);
    if (isMeasured) measuredChapters += 1;
    if (isTested) testedChapters += 1;

    // Untested and measured is a real combination, not a contradiction:
    // practice IS evidence, at a reduced weight, so a student can measure a
    // chapter at home that no paper has ever asked them about. It belongs on
    // the untested list anyway — "no test you have sat has covered this" is
    // exactly what it says, and it is still the thing to tell a teacher.
    if (!isTested) untested.push(chapter);
    else if (!isMeasured) thin.push(chapter);
  }

  const coverage: ReadinessCoverage = {
    measuredConcepts: measured.length,
    totalConcepts: inSyllabus.size,
    measuredChapters,
    testedChapters,
    totalChapters: input.chapters.length,
  };

  // --- The refusals, in the order the facts arrive ---------------------------

  if (subjects.length === 0 || input.chapters.length === 0) {
    return {
      ok: false,
      reason: "no-syllabus",
      subjects,
      coverage,
      untested,
      thin,
      headline: "There is no syllabus to measure you against yet",
      message:
        subjects.length === 0
          ? "You are not in a class yet, so nothing here knows which subjects you are sitting. Join one with the code your teacher gave you and this page fills in."
          : `${sentenceList(subjects)} ${subjects.length === 1 ? "has" : "have"} no chapters recorded here yet, so there is nothing to measure you against. That gap is ours, not yours — ask your teacher, and nothing you do in the meantime is wasted.`,
    };
  }

  if (measured.length === 0) {
    return {
      ok: false,
      reason: "nothing-measured",
      subjects,
      coverage,
      untested,
      thin,
      headline: "We cannot tell you whether you are ready",
      message:
        testedChapters === 0
          ? `Nothing has been measured yet. Once you have sat a test and it has been marked, this page starts filling in — one idea at a time, and it takes ${MIN_EVIDENCE} answers on the same idea before we will say anything about it.`
          : `You have been tested on ${countOf(testedChapters, "chapter")} of the ${input.chapters.length}, but no single idea has ${MIN_EVIDENCE} answers behind it yet, which is the least we will stand behind. That is a statement about how much has been asked, not about you.`,
    };
  }

  if (
    measured.length < MIN_MEASURED_CONCEPTS ||
    measuredChapters < chaptersNeeded(input.chapters.length)
  ) {
    const rest = input.chapters.length - measuredChapters;
    return {
      ok: false,
      reason: "too-thin",
      subjects,
      coverage,
      untested,
      thin,
      headline: "We cannot tell you whether you are ready",
      // The sentence this whole module is built around. It names both numbers,
      // because "we have measured 3 chapters" without the 51 is the flattering
      // half of the fact.
      message:
        `We have measured ${measuredChapters} of the ${input.chapters.length} ${input.chapters.length === 1 ? "chapter" : "chapters"} in your syllabus. ` +
        `That is not enough to tell you whether you are ready. ` +
        `What we know is true about ${measuredChapters === 1 ? "that one" : "those"}; it says nothing about the other ${rest}.`,
    };
  }

  // --- The picture -----------------------------------------------------------
  //
  // The bands come from the estimator, never from thresholds re-typed here.
  // Two definitions of "secure" in one codebase is two definitions that drift,
  // and the mastery scale is reserved — five bands, and the fifth is a refusal.
  const secure = measured.filter((concept) => concept.band === "SECURE");
  const developing = measured.filter((concept) => concept.band === "DEVELOPING");
  const needsWork = measured.filter(
    (concept) => concept.band === "FRAGILE" || concept.band === "CRITICAL",
  );

  // Disjoint by construction — a band is one value — so unlike the report,
  // which sorts by strongest across every band, nothing here can list the same
  // concept as both a strength and a worry. That bug has been shipped twice.
  const attention = [...needsWork]
    .sort((a, b) => a.estimate - b.estimate)
    .slice(0, NAMED);
  const strengths = [...secure]
    .sort((a, b) => b.estimate - a.estimate)
    .slice(0, NAMED);

  return {
    ok: true,
    subjects,
    coverage,
    standing: {
      secure: secure.length,
      developing: developing.length,
      needsWork: needsWork.length,
    },
    attention,
    strengths,
    untested,
    thin,
    summary: writeSummary({
      subjects,
      coverage,
      secure: secure.length,
      developing: developing.length,
      needsWork: needsWork.length,
      untested: untested.length,
    }),
    caveat:
      untested.length === 0
        ? null
        : `This is about the ${countOf(coverage.testedChapters, "chapter")} you have been tested on. The other ${untested.length} are not in it — and that is about what has been set, not about you.`,
  };
}

/**
 * The summary, assembled from the figures rather than written by a model.
 *
 * There is no AI anywhere in this module, for the reason there is none in a
 * report: a warmly-phrased wrong sentence about how ready somebody is, three
 * weeks before their boards, is the worst output this product could produce.
 * The tone is plain on purpose — a student reading this does not need
 * encouragement written into the arithmetic, they need to know where things
 * stand and which chapter nobody has asked them about.
 *
 * Coverage first in the paragraph as well as on the page, because the
 * denominator is the context for every other number in it.
 */
function writeSummary(input: {
  subjects: string[];
  coverage: ReadinessCoverage;
  secure: number;
  developing: number;
  needsWork: number;
  untested: number;
}): string {
  const { coverage } = input;
  const parts: string[] = [];

  parts.push(
    `We have measured ${coverage.measuredConcepts} of the ${coverage.totalConcepts} ideas in ${sentenceList(input.subjects)}, across ${coverage.measuredChapters} of the ${coverage.totalChapters} chapters.`,
  );

  // Counts, in the reserved band order, and never rolled up. The moment these
  // three become one number they are the composite this module refuses.
  parts.push(
    `Of those ${coverage.measuredConcepts}: ${input.secure} secure, ${input.developing} developing, ${input.needsWork} needing work.`,
  );

  if (input.needsWork === 0) {
    parts.push("Nothing measured is below the line.");
  }

  if (input.untested > 0) {
    parts.push(
      `${countOf(input.untested, "chapter")} ${input.untested === 1 ? "has" : "have"} not been on any test you have sat, so nothing here says anything about ${input.untested === 1 ? "it" : "them"}.`,
    );
  }

  return parts.join(" ");
}

/** "3 chapters" / "1 chapter" — the number always travels with the noun. */
function countOf(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** "Mathematics", "Mathematics and Science", "Maths, Science and Hindi". */
function sentenceList(items: string[]): string {
  if (items.length === 0) return "your subjects";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}
