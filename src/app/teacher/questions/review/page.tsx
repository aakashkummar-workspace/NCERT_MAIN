import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { draftCounts, reviewQueue } from "@/core/questions";
import type { QuestionType } from "@/core/questions/validate";
import { cachedPickerOptions } from "@/app/_curriculum/picker";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui";
import { boardPaperNeeds } from "@/core/questions/board-needs";
import { BoardNeeds } from "./BoardNeeds";
import { ReviewQueue } from "./ReviewQueue";

export const metadata: Metadata = { title: "Review drafts" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES: QuestionType[] = [
  "MCQ", "MULTI_SELECT", "TRUE_FALSE", "NUMERIC", "FILL_BLANK",
  "ASSERTION_REASON", "VSA", "SA", "LA", "CASE_STUDY",
];
const TYPE_LABEL: Record<string, string> = {
  MCQ: "Multiple choice",
  MULTI_SELECT: "Multi-select",
  TRUE_FALSE: "True / false",
  NUMERIC: "Numeric",
  FILL_BLANK: "Fill the blank",
  ASSERTION_REASON: "Assertion–reason",
  VSA: "Very short answer",
  SA: "Short answer",
  LA: "Long answer",
  CASE_STUDY: "Case study",
};

/**
 * Where drafts are read and decided, one at a time. The filters are plain GET
 * links, so a reviewer can bookmark "Class 10 Science, chapter 4, short
 * answers" and come back to exactly that queue.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : "");
  const subjectId = UUID.test(one("subjectId")) ? one("subjectId") : "";
  const chapterId = UUID.test(one("chapterId")) ? one("chapterId") : "";
  const type = TYPES.includes(one("type") as QuestionType) ? (one("type") as QuestionType) : undefined;
  const skip = Math.max(Number.parseInt(one("skip"), 10) || 0, 0);

  const organizationId = session.actor.organizationId;
  const [queue, counts, picker, needs] = await Promise.all([
    reviewQueue(organizationId, { subjectId: subjectId || undefined, chapterId: chapterId || undefined, type }, skip),
    draftCounts(organizationId, { subjectId: subjectId || undefined, chapterId: chapterId || undefined }),
    cachedPickerOptions(organizationId),
    boardPaperNeeds(organizationId),
  ]);

  const subject = picker.subjects.find((s) => s.id === subjectId);
  const chapter = picker.chapters.find((c) => c.id === chapterId);
  if ((subjectId && !subject) || (chapterId && (!chapter || chapter.subjectId !== subjectId))) notFound();

  const subjectsWithDrafts = picker.subjects.filter((s) => (counts.bySubject.get(s.id) ?? 0) > 0);
  const chaptersWithDrafts = subjectId
    ? picker.chapters.filter((c) => c.subjectId === subjectId && (counts.byChapter.get(c.id) ?? 0) > 0)
    : [];

  const href = (next: { subjectId?: string; chapterId?: string; type?: string; skip?: number }) => {
    const query = new URLSearchParams();
    if (next.subjectId) query.set("subjectId", next.subjectId);
    if (next.chapterId) query.set("chapterId", next.chapterId);
    if (next.type) query.set("type", next.type);
    if (next.skip) query.set("skip", String(next.skip));
    const text = query.toString();
    return `/teacher/questions/review/${text ? `?${text}` : ""}`;
  };

  return (
    <AppShell
      currentPath="/teacher/questions"
      fullName={session.fullName}
      organizationName={session.organizationName}
      breadcrumbs={[{ label: "Question Bank", href: "/teacher/questions" }, { label: "Review drafts" }]}
    >
      <PageHeader
        title="Review drafts"
        description={`${counts.total} ${counts.total === 1 ? "draft is" : "drafts are"} waiting in the bank. A draft cannot go in a paper until someone approves it.`}
      />

      {/* Where to start: the sections a review would unlock. Nothing here
          approves anything — it only orders the reading. */}
      <BoardNeeds
        needs={needs}
        href={(next) => href({ subjectId: next.subjectId, type: next.type })}
        subjectLabel={(id) => picker.subjects.find((s) => s.id === id)?.label ?? "This subject"}
      />

      <nav className="ui-rq-filters" aria-label="Filter the drafts">
        <div className="ui-rq-filter">
          <span className="ui-rq-filter-label">Subject</span>
          <Link href={href({ type })} aria-current={!subjectId ? "page" : undefined}>
            All <span className="tabular">({counts.total})</span>
          </Link>
          {subjectsWithDrafts.map((s) => (
            <Link key={s.id} href={href({ subjectId: s.id, type })} aria-current={s.id === subjectId ? "page" : undefined}>
              {s.label} <span className="tabular">({counts.bySubject.get(s.id)})</span>
            </Link>
          ))}
        </div>
        {chaptersWithDrafts.length > 0 && (
          <div className="ui-rq-filter">
            <span className="ui-rq-filter-label">Chapter</span>
            <Link href={href({ subjectId, type })} aria-current={!chapterId ? "page" : undefined}>
              All
            </Link>
            {chaptersWithDrafts.map((c) => (
              <Link key={c.id} href={href({ subjectId, chapterId: c.id, type })} aria-current={c.id === chapterId ? "page" : undefined}>
                {c.number}. {c.title} <span className="tabular">({counts.byChapter.get(c.id)})</span>
              </Link>
            ))}
          </div>
        )}
        <div className="ui-rq-filter">
          <span className="ui-rq-filter-label">Type</span>
          <Link href={href({ subjectId, chapterId })} aria-current={!type ? "page" : undefined}>
            All
          </Link>
          {TYPES.filter((t) => (counts.byType.get(t) ?? 0) > 0 || t === type).map((t) => (
            <Link key={t} href={href({ subjectId, chapterId, type: t })} aria-current={t === type ? "page" : undefined}>
              {TYPE_LABEL[t]} <span className="tabular">({counts.byType.get(t) ?? 0})</span>
            </Link>
          ))}
        </div>
      </nav>

      <p className="ui-hint" style={{ margin: "0 0 14px" }}>
        Keys: <kbd className="ui-kbd">A</kbd> approve · <kbd className="ui-kbd">R</kbd> reject ·{" "}
        <kbd className="ui-kbd">E</kbd> edit · <kbd className="ui-kbd">S</kbd> or → skip · ← back. Each
        question is approved on its own — there is no approve-all, because an approval nobody read is
        not an approval.
      </p>

      <ReviewQueue
        key={`${subjectId}|${chapterId}|${type ?? ""}|${skip}`}
        initialItems={queue.items}
        remaining={queue.remaining}
        batchHref={href({ subjectId, chapterId, type })}
        skippedBefore={skip}
        subjects={picker.subjects}
        chapters={picker.chapters}
        outcomes={picker.outcomes}
      />
    </AppShell>
  );
}
