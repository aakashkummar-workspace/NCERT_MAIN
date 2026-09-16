import { z } from "zod";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { subjectReview } from "@/core/curriculum/review";
import { Badge, PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "Review a subject" };

export default async function SubjectReviewPage({
  params,
}: {
  params: Promise<{ subjectId: string }>;
}) {
  const { subjectId } = await params;
  // A malformed id is a page that does not exist, not a database error.
  if (!z.uuid().safeParse(subjectId).success) notFound();
  const subject = await subjectReview(subjectId);
  if (!subject) notFound();

  return (
    <Stack>
      <PageHeader
        eyebrow={
          <>
            <Link href="/admin/review">Review</Link> · {subject.gradeLabel}
          </>
        }
        title={subject.name}
        description="Open a chapter to read its outcomes, concepts and tagged questions."
      />
      <ol className="ui-chapter-list">
        {subject.chapters.map((chapter) => {
          const outstanding =
            chapter.outcomes.total -
            chapter.outcomes.reviewed +
            (chapter.tags.total - chapter.tags.reviewed);
          return (
            <li key={chapter.id}>
              <Link href={`/admin/review/chapter/${chapter.id}`}>
                <span className="ui-chapter-number tabular">{chapter.number}</span>
                <span className="ui-chapter-title">{chapter.title}</span>
                <span className="ui-chapter-counts">
                  {chapter.outcomes.total === 0 ? (
                    <Badge tone="neutral">No outcomes yet</Badge>
                  ) : outstanding === 0 ? (
                    <Badge tone="success">Reviewed</Badge>
                  ) : (
                    <Badge tone="warning">
                      {chapter.outcomes.reviewed}/{chapter.outcomes.total} outcomes ·{" "}
                      {chapter.tags.reviewed}/{chapter.tags.total} tags
                    </Badge>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </Stack>
  );
}
