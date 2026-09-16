import "server-only";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { conceptsForSubjects } from "@/core/curriculum/concepts";
import {
  buildReadiness,
  type Readiness,
  type ReadinessChapter,
  type ReadinessConcept,
} from "./build";

/**
 * Exam readiness, assembled.
 *
 * All the reading is here; all the deciding is in `build.ts`. The same split as
 * the study plan, the recommender and the mastery estimator, and for the same
 * reason: the rule that decides what a student believes about their own
 * preparation has to be arguable without reading a query, and testable without
 * a database.
 *
 * ---------------------------------------------------------------------------
 * Nothing is stored
 * ---------------------------------------------------------------------------
 * Every figure is derived at read time, exactly as an assignment's status is
 * derived from two timestamps. A stored readiness picture would be stale the
 * moment a paper was marked or a practice set finished; keeping it fresh would
 * need a job, and between ticks the row would be a lie — read by a student
 * deciding what to revise tonight.
 *
 * There is also nothing to acknowledge and nothing to tick off. This page moves
 * when the evidence moves and on nothing else, which is the rule a learning gap
 * and a mistake already follow.
 *
 * ---------------------------------------------------------------------------
 * The syllabus is read here, the curriculum plane through its own module
 * ---------------------------------------------------------------------------
 * The concept denominator comes from `conceptsForSubjects` rather than being
 * re-derived here. Two functions that both answer "how many ideas are in this
 * syllabus", disagreeing, would put a different number on a student's
 * readiness page and on the report their parent is handed at the same meeting.
 *
 * The chapter reads run inside `withTenant` alongside the tenant ones. The
 * curriculum plane carries no organization_id and its policy is
 * `for select using (true)`, so a tenant-scoped transaction reads it perfectly
 * well — the same thing `core/questions` does when it checks a chapter. What
 * this module may NOT do is hold the raw client: the layering rule exempts
 * `core/curriculum` from `withTenant` and nothing else, and widening that
 * exemption per feature is how it stops meaning anything.
 */

export type Actor = { organizationId: string; userId: string };

/**
 * Chapters numbered at or above this are test fixtures, never syllabus.
 *
 * The same floor `scripts/lib/fixture-curriculum.mjs` numbers them from. Not
 * imported from there: application code does not reach into scripts, and a
 * syllabus chapter 1000 is not a thing that will ever exist to disagree.
 */
export const FIXTURE_CHAPTER_FLOOR = 1000;

type ChapterRow = {
  id: string;
  subjectId: string;
  number: number;
  title: string;
};

type ConceptChapterRow = {
  conceptId: string;
  outcome: { topic: { chapterId: string } };
};

export type {
  MeasuredConcept,
  Readiness,
  ReadinessChapter,
  ReadinessConcept,
  ReadinessCoverage,
} from "./build";
export { MIN_MEASURED_CONCEPTS, MIN_CHAPTER_FRACTION, chaptersNeeded } from "./build";

export async function examReadiness(actor: Actor): Promise<Readiness> {
  const read = await withTenant(actor.organizationId, async (tx) => {
    // The subjects they are actually sitting, from their live enrolments. A
    // class they have left is not their syllabus, and counting its chapters
    // would move the denominator for a reason nobody could explain.
    const enrolments = await tx.classEnrolment.findMany({
      where: { studentUserId: actor.userId, status: "ACTIVE" },
      select: { classId: true },
    });
    const classes = await tx.class.findMany({
      where: { id: { in: enrolments.map((row) => row.classId) }, status: "ACTIVE" },
      select: { subjectId: true, subject: { select: { name: true } } },
    });

    const subjectNameById = new Map<string, string>();
    for (const klass of classes) {
      subjectNameById.set(klass.subjectId, klass.subject.name);
    }
    const subjectIds = [...subjectNameById.keys()];

    // Not enrolled anywhere: there is no syllabus, and four more queries would
    // all be asked about an empty list. `build` turns this into the refusal
    // that says so.
    const chapters: ChapterRow[] =
      subjectIds.length === 0
        ? []
        : await tx.chapter.findMany({
            where: {
              subjectId: { in: subjectIds },
              // Not a test's fixture chapter. The integration and smoke runs
              // author curriculum at chapter 1000 and above — no syllabus has
              // one — and while a run is going those chapters sit inside real
              // subjects, moving every student's denominator.
              number: { lt: FIXTURE_CHAPTER_FLOOR },
            },
            select: { id: true, subjectId: true, number: true, title: true },
          });

    // Which chapters teach each concept. This is the edge that lets a chapter
    // be called measured at all — mastery is held against concepts, and a
    // student thinks in chapters.
    const links: ConceptChapterRow[] =
      subjectIds.length === 0
        ? []
        : await tx.conceptOutcome.findMany({
            where: {
              outcome: {
                topic: {
                  chapter: {
                    subjectId: { in: subjectIds },
                    number: { lt: FIXTURE_CHAPTER_FLOOR },
                  },
                },
              },
            },
            select: {
              conceptId: true,
              outcome: { select: { topic: { select: { chapterId: true } } } },
            },
          });

    const mastery = await tx.studentConceptMastery.findMany({
      where: { studentUserId: actor.userId },
      select: {
        conceptId: true,
        band: true,
        estimate: true,
        evidenceCount: true,
      },
    });

    return {
      subjectNameById,
      chapters,
      links,
      mastery,
      testedChapterIds: await testedChapters(tx, actor.userId),
    };
  });

  const chaptersByConcept = new Map<string, string[]>();
  for (const link of read.links) {
    const list = chaptersByConcept.get(link.conceptId) ?? [];
    if (!list.includes(link.outcome.topic.chapterId)) {
      list.push(link.outcome.topic.chapterId);
    }
    chaptersByConcept.set(link.conceptId, list);
  }

  const subjectIds = [...read.subjectNameById.keys()];
  // `conceptsForSubjects` derives the syllabus from the same outcome links, but
  // over every chapter, fixtures included. Keeping only concepts that reach a
  // real chapter is that same list with a test run's concepts taken out.
  const syllabus = (await conceptsForSubjects(subjectIds)).filter((row) =>
    chaptersByConcept.has(row.conceptId),
  );
  const conceptNameById = new Map(
    syllabus.map((row) => [row.conceptId, row.conceptName]),
  );

  const chapters: ReadinessChapter[] = read.chapters
    .map((chapter) => ({
      chapterId: chapter.id,
      subjectName: read.subjectNameById.get(chapter.subjectId) ?? "This subject",
      number: chapter.number,
      title: chapter.title,
    }))
    // Sorted, not incidental. A list whose order changes between two page
    // loads is one a student cannot compare against what they saw yesterday —
    // the same reason the analytics grid fixes its column order.
    .sort(
      (a, b) => a.subjectName.localeCompare(b.subjectName) || a.number - b.number,
    );

  const concepts: ReadinessConcept[] = read.mastery.map((row) => ({
    conceptId: row.conceptId,
    conceptName: conceptNameById.get(row.conceptId) ?? "this idea",
    band: row.band as ReadinessConcept["band"],
    // Null in the column whenever the band is INSUFFICIENT, so a number the
    // estimator refused to produce never enters the process at all. It is not
    // hidden downstream; it is not here.
    estimate: row.estimate === null ? null : Number(row.estimate),
    evidenceCount: row.evidenceCount,
  }));

  return buildReadiness({
    // From the enrolments, NOT from the chapters that came back. A subject
    // with no chapters recorded yet is a real seeded state — Hindi, English
    // and Social Science are all in it — and deriving the subject list from
    // the chapter list would collapse that case into "you are not in a class",
    // which sends a student to fix something that is not theirs to fix.
    subjectNames: [...read.subjectNameById.values()].sort((a, b) =>
      a.localeCompare(b),
    ),
    syllabusConceptIds: syllabus.map((row) => row.conceptId),
    concepts,
    chapters,
    testedChapterIds: read.testedChapterIds,
    chaptersByConcept,
  });
}

/**
 * The concepts whose trend arrow means something: evidence from more than one
 * sitting.
 *
 * `trend` compares an estimate with the one before its last recomputation, and
 * a recomputation happens when anything is MARKED — not only when something is
 * sat. So one paper whose objective answers landed at submission and whose
 * written answer was marked an hour later produced "holding steady" after a
 * single sitting: the paper compared with itself. So an arrow is shown only
 * where the evidence comes from at least two sittings — two papers, two
 * practice sets, or one of each.
 *
 * Here rather than in the ledger because it is a question about what to SHOW a
 * student; the stored trend is left alone for the screens that read it.
 */
export async function conceptsWithSeparateReadings(
  actor: Actor,
): Promise<Set<string>> {
  const sittingsByConcept = await withTenant(actor.organizationId, async (tx) => {
    const evidence = await tx.conceptEvidence.findMany({
      where: { studentUserId: actor.userId },
      select: { conceptId: true, attemptAnswerId: true, practiceAnswerId: true },
    });
    if (evidence.length === 0) return new Map<string, Set<string>>();

    const attemptAnswerIds = evidence.flatMap((row) =>
      row.attemptAnswerId ? [row.attemptAnswerId] : [],
    );
    const practiceAnswerIds = evidence.flatMap((row) =>
      row.practiceAnswerId ? [row.practiceAnswerId] : [],
    );
    const [attemptAnswers, practiceAnswers] = await Promise.all([
      attemptAnswerIds.length === 0
        ? []
        : tx.attemptAnswer.findMany({
            where: { id: { in: attemptAnswerIds } },
            select: { id: true, attemptId: true },
          }),
      practiceAnswerIds.length === 0
        ? []
        : tx.practiceAnswer.findMany({
            where: { id: { in: practiceAnswerIds } },
            select: { id: true, practiceSessionId: true },
          }),
    ]);
    const attemptOf = new Map(attemptAnswers.map((row) => [row.id, row.attemptId]));
    const sessionOf = new Map(
      practiceAnswers.map((row) => [row.id, row.practiceSessionId]),
    );

    const sittings = new Map<string, Set<string>>();
    for (const row of evidence) {
      const sitting = row.attemptAnswerId
        ? `a:${attemptOf.get(row.attemptAnswerId) ?? row.attemptAnswerId}`
        : row.practiceAnswerId
          ? `p:${sessionOf.get(row.practiceAnswerId) ?? row.practiceAnswerId}`
          : null;
      if (sitting === null) continue;
      const set = sittings.get(row.conceptId) ?? new Set<string>();
      set.add(sitting);
      sittings.set(row.conceptId, set);
    }
    return sittings;
  });

  return new Set(
    [...sittingsByConcept]
      .filter(([, sittings]) => sittings.size >= 2)
      .map(([conceptId]) => conceptId),
  );
}

/**
 * The chapters a paper this student SAT carried a question from.
 *
 * Read from the papers rather than from the evidence ledger, and the
 * distinction matters: an outcome with no concept mapped to it produces no
 * evidence, so "tested" derived from the ledger would call a chapter untested
 * after the student had sat a whole paper on it. One visibly false line is all
 * it takes for a fifteen-year-old to stop reading the page.
 *
 * Submitted sittings only. A paper open on the desk has not tested anybody
 * yet, and counting it would change the list under a student mid-exam.
 *
 * Every question on the paper counts, not only the ones they answered. A
 * chapter they were asked about and left blank was still examined — that is a
 * fact about what has been set, which is what this list is for.
 */
async function testedChapters(
  tx: Prisma.TransactionClient,
  studentUserId: string,
): Promise<string[]> {
  const attempts = await tx.attempt.findMany({
    where: { studentUserId, submittedAt: { not: null } },
    select: { assignmentId: true },
  });
  const assignmentIds = [...new Set(attempts.map((row) => row.assignmentId))];
  if (assignmentIds.length === 0) return [];

  const assignments = await tx.assignment.findMany({
    where: { id: { in: assignmentIds } },
    select: { assessmentId: true },
  });
  const assessmentIds = [...new Set(assignments.map((row) => row.assessmentId))];
  if (assessmentIds.length === 0) return [];

  const rows = await tx.assessmentQuestion.findMany({
    where: { assessmentId: { in: assessmentIds } },
    select: { questionId: true },
  });
  const questionIds = [...new Set(rows.map((row) => row.questionId))];
  if (questionIds.length === 0) return [];

  const questions = await tx.question.findMany({
    where: { id: { in: questionIds } },
    select: { chapterId: true },
  });

  // A question filed under no chapter tells us nothing about coverage. It is a
  // real state — the chapter is optional on a question — and dropping it is
  // right: the alternative is inventing a chapter for it.
  return [
    ...new Set(
      questions.flatMap((row) => (row.chapterId === null ? [] : [row.chapterId])),
    ),
  ];
}
