import "server-only";
import { prisma } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { requireSession } from "@/core/identity/context";

/**
 * Curriculum reads.
 *
 * The curriculum plane is global and carries no organization_id, so these are
 * the one legitimate set of queries that do not run inside withTenant(). Their
 * RLS policy is `for select using (true)`: readable by every tenant, writable
 * by none of them — the app role has no insert, update or delete grant on
 * these tables at all.
 */

/**
 * Subject codes starting `ZZ` are TEST FIXTURES and are never offered to a
 * school. The integration suites need a subject with no chapters, and a class
 * that points at a subject makes it undeletable (`classes.subject_id` is
 * RESTRICT) — so one fixed `ZZNOCHAPTERS` subject is reused rather than a new
 * one per run. It still has to live in CBSE Class 10, because a class can only
 * be created against its organization's own board, which puts it in every
 * teacher's subject picker unless it is filtered here. A real board has no
 * subject code beginning `ZZ`.
 */
export const FIXTURE_SUBJECT_CODE_PREFIX = "ZZ";

export type GradeOption = {
  id: string;
  number: number;
  label: string;
  subjects: { id: string; name: string; shortName: string }[];
};

/**
 * The grades and subjects of ONE board.
 *
 * There is no default board, and that is the whole of this change. The
 * parameter used to read `boardCode = "CBSE"`, which meant every caller that
 * forgot to think about the board got CBSE — correct for every customer the
 * product had, and silently wrong for the first one it did not. A curriculum
 * read that can fall back is a read that shows an ICSE school the CBSE
 * syllabus and looks exactly like a correct answer while doing it.
 *
 * The board id comes from the organization on the session (see
 * `core/organizations`), never from a request.
 */
export async function listGradesWithSubjects(
  boardId?: string,
): Promise<GradeOption[]> {
  // Optional, but never defaulted to a board: omitted, it resolves the
  // organization on the SESSION and reads its board. The parameter exists only
  // to save a lookup for callers that already have the id. There is no code
  // path here that answers without knowing whose board it is answering about.
  const scope = boardId ?? (await boardIdForSession());

  const grades = await prisma.grade.findMany({
    where: { boardId: scope },
    include: {
      subjects: {
        where: { NOT: { code: { startsWith: FIXTURE_SUBJECT_CODE_PREFIX } } },
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: { number: "asc" },
  });

  return grades.map((grade) => ({
    id: grade.id,
    number: grade.number,
    label: grade.label,
    subjects: grade.subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      shortName: subject.shortName,
    })),
  }));
}

/**
 * The academic year a new class defaults to. India's school year starts in
 * April, so a class created in February belongs to the year that began the
 * previous April — not to the calendar year.
 */
export function currentAcademicYear(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0 = January
  const start = month >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export type ChapterGrounding = {
  chapterId: string;
  subjectId: string;
  subjectName: string;
  gradeLabel: string;
  /**
   * Which board's chapter this is. Carried because the generator prompt says
   * it out loud: "write examination questions for the CBSE curriculum" is a
   * lie in front of an ICSE school, and a model told the wrong board writes
   * questions in the wrong register for the paper they will actually sit.
   */
  boardName: string;
  boardCode: string;
  chapterTitle: string;
  outcomes: { id: string; code: string; statement: string }[];
};

/**
 * Everything a generator needs to know about a chapter.
 *
 * Here rather than in `core/questions`, because of where the data is: the
 * curriculum plane carries no `organization_id`, its policy is
 * `for select using (true)`, and `core/curriculum` is the module the layering
 * rules exempt from `withTenant` for exactly that. A question module reaching
 * for the raw client would widen that exemption to somewhere it does not
 * belong.
 *
 * The outcome statements are the point. They are the only grounding a
 * generator has for what a chapter is *for* — a title alone produces plausible
 * questions about the wrong thing.
 */
export async function chapterGrounding(
  chapterId: string,
): Promise<ChapterGrounding | null> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: {
      subject: { include: { grade: { include: { board: true } } } },
      topics: { include: { outcomes: { orderBy: { code: "asc" } } } },
    },
  });
  if (!chapter) return null;

  return {
    chapterId: chapter.id,
    subjectId: chapter.subjectId,
    subjectName: chapter.subject.name,
    gradeLabel: chapter.subject.grade.label,
    boardName: chapter.subject.grade.board.name,
    boardCode: chapter.subject.grade.board.code,
    chapterTitle: chapter.title,
    outcomes: chapter.topics.flatMap((topic) =>
      topic.outcomes.map((outcome) => ({
        id: outcome.id,
        code: outcome.code,
        statement: outcome.statement,
      })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

export type BoardOption = {
  id: string;
  code: string;
  name: string;
  /** Whether anything has been authored under it yet. */
  gradeCount: number;
};

/**
 * Every board on the shared plane, for the signup picker and the settings
 * page.
 *
 * A board with no grades is still listed rather than hidden: the shape of a
 * board is seeded and its content is authored by somebody who teaches the
 * subject, so "ICSE, nothing authored yet" is a real and visible state — the
 * same rule the 50 chapters with no outcomes already follow. The caller says
 * so on screen; hiding it would make the gap discoverable only as an empty
 * class-creation form.
 */
export async function listBoards(): Promise<BoardOption[]> {
  const boards = await prisma.board.findMany({
    include: { _count: { select: { grades: true } } },
    orderBy: { code: "asc" },
  });

  return boards.map((board) => ({
    id: board.id,
    code: board.code,
    name: board.name,
    gradeCount: board._count.grades,
  }));
}

/** Resolve a board by its code. Null when nobody has seeded it. */
export async function boardByCode(code: string): Promise<BoardOption | null> {
  const board = await prisma.board.findUnique({
    where: { code },
    include: { _count: { select: { grades: true } } },
  });
  if (!board) return null;
  return {
    id: board.id,
    code: board.code,
    name: board.name,
    gradeCount: board._count.grades,
  };
}

/**
 * The board of the organization on the session.
 *
 * A deliberately small duplicate of `organizationBoard` in
 * `core/organizations`: that module reads this one for `boardByCode`, and a
 * cycle between the two would be a worse thing to own than six lines. It reads
 * the tenant's own row through `withTenant`, like every other tenant read.
 */
async function boardIdForSession(): Promise<string> {
  const session = await requireSession();
  const organizationId = session.actor.organizationId;
  const row = await withTenant(organizationId, (tx) =>
    tx.organization.findFirst({
      where: { id: organizationId },
      select: { boardId: true },
    }),
  );
  if (!row) throw new Error(`No organization ${organizationId}`);
  return row.boardId;
}
