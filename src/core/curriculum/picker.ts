import "server-only";
import { prisma } from "@/db/client";
import { requireSession } from "@/core/identity/context";
import { organizationBoardId } from "@/core/organizations";

/** Test runs author chapters numbered from here; see scripts/lib/fixture-curriculum.mjs. */
const FIXTURE_CHAPTER_FLOOR = 1000;

/**
 * The chapter and outcome lists a teacher picks from when writing a question.
 *
 * Only chapters that HAVE outcomes are offered for the outcome step, because a
 * question mapped to nothing can be scored but can never inform mastery. The
 * chapter list itself stays complete, so a teacher can still file a question by
 * chapter and see why the outcome picker is empty.
 *
 * ---------------------------------------------------------------------------
 * Board scoping, and why the organization id is optional
 * ---------------------------------------------------------------------------
 * The list is scoped to the board the organization teaches. It has to be: a
 * question filed against another board's chapter would score correctly and
 * then attribute its evidence to a syllabus the school does not teach —
 * exactly the failure `checkCurriculumFit` already treats as an error rather
 * than a warning.
 *
 * The parameter is optional but the SCOPING is not. Omitted, the organization
 * is resolved from the session — never defaulted to a board. Every caller sits
 * behind an authenticated layout, so there is always a session; passing the id
 * only saves the lookup.
 */
export async function questionPickerOptions(organizationId?: string) {
  const orgId =
    organizationId ?? (await requireSession()).actor.organizationId;
  const boardId = await organizationBoardId(orgId);

  const [chapters, subjects] = await Promise.all([
    prisma.chapter.findMany({
      // Fixture chapters (numbered 1000 and up, which no syllabus has) exist
      // only while a test run is going and must never reach a teacher's picker.
      where: { subject: { grade: { boardId } }, number: { lt: FIXTURE_CHAPTER_FLOOR } },
      include: {
        subject: { include: { grade: true } },
        topics: {
          include: { outcomes: { orderBy: { sortOrder: "asc" } } },
          orderBy: { sortOrder: "asc" },
        },
      },
      // The order a teacher reads a syllabus in. Ordering by subject id sorted
      // on a uuid, which put Class 10 Science between two Class 9 subjects.
      orderBy: [
        { subject: { grade: { number: "asc" } } },
        { subject: { sortOrder: "asc" } },
        { subject: { name: "asc" } },
        { number: "asc" },
      ],
    }),
    prisma.subject.findMany({
      where: { grade: { boardId } },
      include: { grade: true },
      orderBy: [{ grade: { number: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
    }),
  ]);

  return {
    subjects: subjects.map((subject) => ({
      id: subject.id,
      gradeId: subject.gradeId,
      label: `${subject.grade.label} · ${subject.name}`,
    })),
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      subjectId: chapter.subjectId,
      number: chapter.number,
      title: chapter.title,
      label: `${chapter.subject.grade.label} · ${chapter.subject.name} · ${chapter.number}. ${chapter.title}`,
      outcomeCount: chapter.topics.reduce(
        (sum, topic) => sum + topic.outcomes.length,
        0,
      ),
    })),
    outcomes: chapters.flatMap((chapter) =>
      chapter.topics.flatMap((topic) =>
        topic.outcomes.map((outcome) => ({
          id: outcome.id,
          chapterId: chapter.id,
          label: `${outcome.code} — ${outcome.statement}`,
        })),
      ),
    ),
  };
}
