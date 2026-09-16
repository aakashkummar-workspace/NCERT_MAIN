import { z } from "zod";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { chapterReview } from "@/core/curriculum/review";
import { PageHeader, Stack } from "@/ui";
import { ChapterReview } from "./ChapterReview";

export const metadata: Metadata = { title: "Review a chapter" };

export default async function ChapterReviewPage({
  params,
}: {
  params: Promise<{ chapterId: string }>;
}) {
  const { chapterId } = await params;
  // A malformed id is a page that does not exist, not a database error.
  if (!z.uuid().safeParse(chapterId).success) notFound();
  const chapter = await chapterReview(chapterId);
  if (!chapter) notFound();

  return (
    <Stack>
      <PageHeader
        eyebrow={
          <>
            <Link href="/admin/review">Review</Link> ·{" "}
            <Link href={`/admin/review/${chapter.subjectId}`}>
              {chapter.gradeLabel} {chapter.subjectName}
            </Link>{" "}
            · Chapter {chapter.number}
          </>
        }
        title={chapter.title}
        description={`${chapter.outcomes.length} outcomes · ${chapter.concepts.length} concepts · ${chapter.questions.length} questions`}
      />
      <ChapterReview
        chapterId={chapter.id}
        outcomes={chapter.outcomes.map((o) => ({
          ...o,
          reviewedAt: o.reviewedAt?.toISOString() ?? null,
        }))}
        concepts={chapter.concepts.map((c) => ({
          ...c,
          reviewedAt: c.reviewedAt?.toISOString() ?? null,
        }))}
        questions={chapter.questions.map((q) => ({
          ...q,
          tagReviewedAt: q.tagReviewedAt?.toISOString() ?? null,
        }))}
        librarySource={chapter.librarySource}
      />
    </Stack>
  );
}
