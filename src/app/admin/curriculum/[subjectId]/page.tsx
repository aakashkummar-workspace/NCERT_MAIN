import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { chaptersForSubject, subjectHeading } from "@/core/curriculum/admin";
import { Badge, EmptyState, PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "Chapters" };

export default async function SubjectPage({
  params,
}: {
  params: Promise<{ subjectId: string }>;
}) {
  const { subjectId } = await params;
  const [subject, chapters] = await Promise.all([
    subjectHeading(subjectId),
    chaptersForSubject(subjectId),
  ]);
  if (!subject) notFound();

  return (
    <Stack>
      <PageHeader
        eyebrow={
          <>
            <Link href="/admin/curriculum">Curriculum</Link> · {subject.gradeLabel}
          </>
        }
        title={subject.name}
        description={`${chapters.length} chapters. Open one to author its topics and learning outcomes.`}
      />

      {chapters.length === 0 ? (
        <EmptyState
          icon="◳"
          title="No chapters for this subject yet"
          body="Chapters come from the seed in prisma/curriculum.ts, which covers Mathematics and Science for Class 9 and 10. Add this subject there and re-run npm run db:seed."
        />
      ) : (
        <ol className="ui-chapter-list">
          {chapters.map((chapter) => (
            <li key={chapter.id}>
              <Link href={`/admin/curriculum/chapter/${chapter.id}`}>
                <span className="ui-chapter-number tabular">{chapter.number}</span>
                <span className="ui-chapter-title">{chapter.title}</span>
                <span className="ui-chapter-counts">
                  {chapter.outcomeCount > 0 ? (
                    <Badge tone="success">
                      {chapter.outcomeCount}{" "}
                      {chapter.outcomeCount === 1 ? "outcome" : "outcomes"}
                    </Badge>
                  ) : (
                    <Badge tone="warning">Needs outcomes</Badge>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Stack>
  );
}
