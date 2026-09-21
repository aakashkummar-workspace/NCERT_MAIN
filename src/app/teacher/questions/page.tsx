import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { bankCounts, bankSummary, searchQuestions, type BankFilters } from "@/core/questions";
import { questionPickerOptions } from "@/core/curriculum/picker";
import { listGradesWithSubjects } from "@/core/curriculum";
import { organizationBoardId } from "@/core/organizations";
import { BANK_PAGE_SIZE } from "./page-size";
import { AppShell } from "@/ui/AppShell";
import { EmptyState, PageHeader, Stack } from "@/ui";
import { BankBrowser, type Filters } from "./BankBrowser";

export const metadata: Metadata = { title: "Question Bank" };

const STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED", "ARCHIVED"];
const TYPES = [
  "MCQ",
  "MULTI_SELECT",
  "TRUE_FALSE",
  "NUMERIC",
  "FILL_BLANK",
  "ASSERTION_REASON",
  "VSA",
  "SA",
  "LA",
  "CASE_STUDY",
];
const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Count = { total: number; approved: number };
const countText = (count: Count | undefined) =>
  !count || count.total === 0
    ? "No questions yet"
    : `${count.total} ${count.total === 1 ? "question" : "questions"} · ${count.approved} approved`;

/**
 * The bank opens as a path, not a list: Class → Subject → Chapter → that
 * chapter's questions, with their answers. Three thousand questions in one
 * scroll is a list nobody reads; a teacher setting a paper already knows the
 * class and the chapter, so those are the first two things asked.
 *
 * Every step lives in the URL, so Back walks the path. Searching the whole bank
 * is still one link away (`?all=1`), and any search or filter in the URL opens
 * that view directly, so older links keep working.
 */
export default async function QuestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  // Anything unrecognised is dropped, not trusted.
  const params = await searchParams;
  const one = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  const filters: Filters = {
    search: one("q").slice(0, 200),
    status: STATUSES.includes(one("status")) ? one("status") : "",
    type: TYPES.includes(one("type")) ? one("type") : "",
    subjectId: UUID.test(one("subjectId")) ? one("subjectId") : "",
    chapterId: UUID.test(one("chapterId")) ? one("chapterId") : "",
    difficulty: DIFFICULTIES.includes(one("difficulty")) ? one("difficulty") : "",
  };
  const gradeParam = UUID.test(one("gradeId")) ? one("gradeId") : "";
  const browseAll = one("all") === "1";

  const organizationId = session.actor.organizationId;
  const [whole, picker, grades] = await Promise.all([
    // Unfiltered, for "is the bank empty at all".
    bankSummary(organizationId),
    questionPickerOptions(organizationId),
    organizationBoardId(organizationId).then((boardId) => listGradesWithSubjects(boardId)),
  ]);

  const subject = grades
    .flatMap((grade) => grade.subjects.map((s) => ({ ...s, grade })))
    .find((s) => s.id === filters.subjectId);
  const chapter = picker.chapters.find((c) => c.id === filters.chapterId);
  // A chapter from another subject, or ids for nothing this school teaches, are
  // a malformed address rather than an empty list.
  if ((filters.subjectId && !subject) || (filters.chapterId && (!chapter || chapter.subjectId !== filters.subjectId))) {
    notFound();
  }
  const grade = subject?.grade ?? grades.find((g) => g.id === gradeParam);
  if (gradeParam && !grade) notFound();

  const refined = Boolean(filters.search || filters.status || filters.type || filters.difficulty);
  const step = chapter
    ? "questions"
    : browseAll || refined
      ? "all"
      : subject
        ? "chapters"
        : grade
          ? "subjects"
          : "classes";

  const crumbs = [
    { label: "Question Bank", href: "/teacher/questions/" },
    ...(grade ? [{ label: grade.label, href: `/teacher/questions/?gradeId=${grade.id}` }] : []),
    ...(subject && step !== "all" ? [{ label: subject.name, href: `/teacher/questions/?subjectId=${subject.id}` }] : []),
    ...(chapter ? [{ label: `${chapter.number}. ${chapter.title}`, href: "" }] : []),
  ];

  // The queue opens on the same subject and chapter the bank is showing.
  const reviewQuery = new URLSearchParams();
  if (filters.subjectId) reviewQuery.set("subjectId", filters.subjectId);
  if (filters.chapterId) reviewQuery.set("chapterId", filters.chapterId);
  const reviewHref = `/teacher/questions/review/${reviewQuery.size ? `?${reviewQuery}` : ""}`;

  const actions = (
    <>
      {whole.draft > 0 && (
        <Link href={reviewHref} className="ui-button" data-variant="secondary" data-size="md">
          <span>Review drafts ({whole.draft})</span>
        </Link>
      )}
      <Link href="/teacher/questions/generate" className="ui-button" data-variant="secondary" data-size="md">
        <span>Generate drafts</span>
      </Link>
      <Link href="/teacher/questions/new" className="ui-button" data-variant="primary" data-size="md">
        <span>Write a question</span>
      </Link>
    </>
  );

  const shell = (children: React.ReactNode, title: string, description?: string) => (
    <AppShell currentPath="/teacher/questions" fullName={session.fullName} organizationName={session.organizationName}>
      <PageHeader title={title} description={description} actions={actions} />
      {children}
    </AppShell>
  );

  if (whole.total === 0) {
    return shell(
      <EmptyState
        icon="◰"
        title="Your question bank is empty"
        body="Questions you add here can be reused in every assessment you build. Each one is linked to a learning outcome, which is what lets the product tell you afterwards which concepts your class has actually secured."
        actions={
          <Link href="/teacher/questions/new" className="ui-button" data-variant="primary" data-size="md">
            <span>Write your first question</span>
          </Link>
        }
      />,
      "Question Bank",
    );
  }

  const trail = (
    <nav className="ui-qb-trail" aria-label="Where you are in the bank">
      <ol>
        {crumbs.map((crumb, index) => (
          <li key={index}>
            {crumb.href && index < crumbs.length - 1 ? <Link href={crumb.href}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
          </li>
        ))}
      </ol>
      {step !== "all" && (
        <Link href="/teacher/questions/?all=1" className="ui-qb-search-all">
          Search the whole bank
        </Link>
      )}
    </nav>
  );

  if (step === "classes" || step === "subjects" || step === "chapters") {
    const counts = await bankCounts(organizationId);
    let tiles: { href: string; eyebrow?: string; title: string; count: Count | undefined }[];
    let title: string;
    let description: string;

    if (step === "classes") {
      title = "Question Bank";
      description = `${whole.total} questions · ${whole.approved} approved and ready to use. Choose a class.`;
      tiles = grades.map((g) => {
        const count = g.subjects.reduce<Count>(
          (sum, s) => {
            const c = counts.bySubject.get(s.id);
            return { total: sum.total + (c?.total ?? 0), approved: sum.approved + (c?.approved ?? 0) };
          },
          { total: 0, approved: 0 },
        );
        return {
          href: `/teacher/questions/?gradeId=${g.id}`,
          eyebrow: `${g.subjects.length} ${g.subjects.length === 1 ? "subject" : "subjects"}`,
          title: g.label,
          count,
        };
      });
    } else if (step === "subjects") {
      title = grade!.label;
      description = "Choose a subject.";
      tiles = grade!.subjects.map((s) => ({
        href: `/teacher/questions/?subjectId=${s.id}`,
        eyebrow: `${picker.chapters.filter((c) => c.subjectId === s.id).length} chapters`,
        title: s.name,
        count: counts.bySubject.get(s.id),
      }));
    } else {
      title = subject!.name;
      description = `${grade!.label} · choose a chapter.`;
      tiles = picker.chapters
        .filter((c) => c.subjectId === subject!.id)
        .map((c) => ({
          href: `/teacher/questions/?subjectId=${subject!.id}&chapterId=${c.id}`,
          eyebrow: `Chapter ${c.number}`,
          title: c.title,
          count: counts.byChapter.get(c.id),
        }));
    }

    const unfiled =
      step === "chapters"
        ? (counts.bySubject.get(subject!.id)?.total ?? 0) -
          picker.chapters
            .filter((c) => c.subjectId === subject!.id)
            .reduce((sum, c) => sum + (counts.byChapter.get(c.id)?.total ?? 0), 0)
        : 0;

    return shell(
      <Stack>
        {trail}
        {tiles.length === 0 ? (
          <p className="ui-hint">
            {step === "chapters" ? "This subject has no chapters yet." : "Nothing to choose here yet."}
          </p>
        ) : (
          <ul className="ui-qb-tiles" data-step={step}>
            {tiles.map((tile) => (
              <li key={tile.href}>
                <Link href={tile.href} className="ui-qb-tile" data-empty={!tile.count?.total || undefined}>
                  {tile.eyebrow && <span className="ui-qb-tile-eyebrow">{tile.eyebrow}</span>}
                  <span className="ui-qb-tile-title">{tile.title}</span>
                  <span className="ui-qb-tile-count tabular">{countText(tile.count)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {unfiled > 0 && (
          <p className="ui-hint">
            {unfiled} {unfiled === 1 ? "question in this subject is" : "questions in this subject are"} not filed
            under a chapter.{" "}
            <Link href={`/teacher/questions/?all=1&subjectId=${subject!.id}`}>See every question in {subject!.name}</Link>
          </p>
        )}
      </Stack>,
      title,
      description,
    );
  }

  // The two list views: one chapter's questions, or the whole bank searched.
  const bankFilters: BankFilters = {
    search: filters.search || undefined,
    status: (filters.status || undefined) as BankFilters["status"],
    type: (filters.type || undefined) as BankFilters["type"],
    subjectId: filters.subjectId || undefined,
    chapterId: filters.chapterId || undefined,
    difficulty: (filters.difficulty || undefined) as BankFilters["difficulty"],
  };
  const [first, summary] = await Promise.all([
    searchQuestions(organizationId, { ...bankFilters, limit: BANK_PAGE_SIZE }),
    bankSummary(organizationId, bankFilters),
  ]);

  const inChapter = step === "questions";
  return shell(
    <Stack>
      {trail}
      <BankBrowser
        initialFilters={filters}
        initial={first.rows}
        initialTotal={first.total}
        summary={summary}
        locked={inChapter}
        extraParams={inChapter ? {} : { all: "1" }}
        subjects={picker.subjects}
        chapters={picker.chapters.map((c) => ({
          id: c.id,
          subjectId: c.subjectId,
          label: `${c.number}. ${c.title}`,
        }))}
      />
    </Stack>,
    inChapter ? `${chapter!.number}. ${chapter!.title}` : "Search the question bank",
    inChapter
      ? `${grade!.label} · ${subject!.name} · questions with their answers`
      : `${whole.total} questions · ${whole.approved} approved and ready to use`,
  );
}
