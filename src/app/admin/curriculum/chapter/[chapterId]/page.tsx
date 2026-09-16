import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { chapterDetail } from "@/core/curriculum/admin";
import { PageHeader, Stack } from "@/ui";
import { ChapterEditor } from "./ChapterEditor";

export const metadata: Metadata = { title: "Chapter" };

export default async function ChapterPage({
  params,
}: {
  params: Promise<{ chapterId: string }>;
}) {
  const { chapterId } = await params;
  const chapter = await chapterDetail(chapterId);
  if (!chapter) notFound();

  const outcomes = chapter.topics.reduce(
    (sum, topic) => sum + topic.outcomes.length,
    0,
  );

  return (
    <Stack>
      <PageHeader
        eyebrow={
          <>
            <Link href="/admin/curriculum">Curriculum</Link> ·{" "}
            <Link href={`/admin/curriculum/${chapter.subjectId}`}>
              {chapter.gradeLabel} {chapter.subjectName}
            </Link>{" "}
            · Chapter {chapter.number}
          </>
        }
        title={chapter.title}
        description={
          chapter.topics.length === 0
            ? "No outcomes yet. Add a topic, then write what a student can do."
            : outcomes === 0
              ? `${count(chapter.topics.length, "topic", "topics")} · no outcomes yet. Write what a student can do.`
              : `${count(chapter.topics.length, "topic", "topics")} · ${count(outcomes, "learning outcome", "learning outcomes")}`
        }
      />

      {chapter.source && (
        <p className="ui-provenance">
          <strong>Source:</strong> {chapter.source}
        </p>
      )}

      <ChapterEditor chapterId={chapter.id} topics={chapter.topics} />
    </Stack>
  );
}

/** Through Intl.PluralRules, never `n === 1` — the rule the rest of the product follows. */
function count(n: number, one: string, other: string): string {
  return `${n} ${new Intl.PluralRules("en-IN").select(n) === "one" ? one : other}`;
}
