import "server-only";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { FIXTURE_SUBJECT_CODE_PREFIX } from "./index";
import { parseChapterContents, type ChapterContents } from "./chapter-contents";

/**
 * The syllabus index: every class, subject and chapter the organization's board
 * teaches, with each chapter's topics, learning outcomes and how many approved
 * questions the organization's bank holds for it.
 *
 * Read live on every request. The curriculum plane is the single source, and an
 * index that is a copy of it is an index that goes out of date the first time a
 * chapter is authored.
 *
 * Two planes, read the way each must be: the curriculum through the global
 * select policy, the question counts inside the organization's own tenant — a
 * school sees the size of ITS bank, never another school's.
 *
 * Test fixtures never appear: subjects coded `ZZ…` and chapters numbered 1000+
 * exist only while a test run is going (CLAUDE.md, "Tests that depend on the
 * world staying unchanged").
 */

export type SyllabusOutcome = {
  code: string;
  statement: string;
  /** False until a subject teacher has approved it at /admin/review. */
  reviewed: boolean;
};

export type SyllabusTopic = {
  title: string;
  outcomes: SyllabusOutcome[];
};

export type SyllabusChapter = {
  id: string;
  number: number;
  title: string;
  topics: SyllabusTopic[];
  outcomeCount: number;
  /** Approved, not deleted, in this organization's own bank. */
  questionCount: number;
  /** Read from the NCERT book; null until it has been. */
  contents: ChapterContents | null;
};

export type SyllabusSubject = {
  id: string;
  name: string;
  chapters: SyllabusChapter[];
  questionCount: number;
  outcomeCount: number;
};

export type SyllabusGrade = {
  id: string;
  number: number;
  label: string;
  subjects: SyllabusSubject[];
};

const FIXTURE_CHAPTER_FLOOR = 1000;

export async function syllabusIndex(organizationId: string): Promise<{
  boardName: string;
  grades: SyllabusGrade[];
}> {
  const org = await withTenant(organizationId, (tx) =>
    tx.organization.findFirstOrThrow({
      where: { id: organizationId },
      select: { board: { select: { id: true, name: true } } },
    }),
  );

  const [grades, counts] = await Promise.all([
    prisma.grade.findMany({
      where: { boardId: org.board.id },
      orderBy: { number: "asc" },
      include: {
        subjects: {
          where: { NOT: { code: { startsWith: FIXTURE_SUBJECT_CODE_PREFIX } } },
          orderBy: { sortOrder: "asc" },
          include: {
            chapters: {
              where: { number: { lt: FIXTURE_CHAPTER_FLOOR } },
              orderBy: { number: "asc" },
              include: {
                topics: {
                  orderBy: { sortOrder: "asc" },
                  include: {
                    outcomes: {
                      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
                      select: { code: true, statement: true, reviewedAt: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
    withTenant(organizationId, (tx) =>
      tx.question.groupBy({
        by: ["chapterId"],
        where: { deletedAt: null, status: "APPROVED", chapterId: { not: null } },
        _count: true,
      }),
    ),
  ]);

  const questionsByChapter = new Map(counts.map((row) => [row.chapterId, row._count]));

  return {
    boardName: org.board.name,
    grades: grades.map((grade) => ({
      id: grade.id,
      number: grade.number,
      label: grade.label,
      subjects: grade.subjects.map((subject) => {
        const chapters = subject.chapters.map((chapter) => {
          const topics = chapter.topics.map((topic) => ({
            title: topic.title,
            outcomes: topic.outcomes.map((outcome) => ({
              code: outcome.code,
              statement: outcome.statement,
              reviewed: outcome.reviewedAt !== null,
            })),
          }));
          return {
            id: chapter.id,
            number: chapter.number,
            title: chapter.title,
            topics,
            outcomeCount: topics.reduce((sum, topic) => sum + topic.outcomes.length, 0),
            questionCount: questionsByChapter.get(chapter.id) ?? 0,
            contents: parseChapterContents(chapter.contents),
          };
        });
        return {
          id: subject.id,
          name: subject.name,
          chapters,
          questionCount: chapters.reduce((sum, chapter) => sum + chapter.questionCount, 0),
          outcomeCount: chapters.reduce((sum, chapter) => sum + chapter.outcomeCount, 0),
        };
      }),
    })),
  };
}

/** The subjects of the classes a student is actively enrolled in, to mark "your class". */
export async function studentSubjectIds(
  organizationId: string,
  studentUserId: string,
): Promise<Set<string>> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.classEnrolment.findMany({
      where: { studentUserId, status: "ACTIVE", leftAt: null },
      select: { class: { select: { subjectId: true } } },
    }),
  );
  return new Set(rows.map((row) => row.class.subjectId));
}
