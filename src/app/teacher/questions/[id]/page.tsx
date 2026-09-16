import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getQuestion } from "@/core/questions";
import { questionItemStats } from "@/core/itemstats";
import { questionPickerOptions } from "@/core/curriculum/picker";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui";
import { QuestionDetail } from "./QuestionDetail";

export const metadata: Metadata = { title: "Question" };

export default async function QuestionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  const question = await getQuestion(session.actor.organizationId, id);
  if (!question) notFound();

  const { subjects, chapters, outcomes } = await questionPickerOptions();

  // Derived on every read, and written nowhere. A stored statistic is stale the
  // moment the next paper is marked — the same reason an assignment has no
  // status column and the study plan has no table. This is a page a teacher
  // opens one question at a time, not a hot path.
  const stats = await questionItemStats(session.actor.organizationId, id);

  return (
    <AppShell
      currentPath="/teacher/questions"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={
          <>
            <Link href="/teacher/questions">Question Bank</Link>
            {question.chapterTitle ? ` · ${question.chapterTitle}` : ""}
          </>
        }
        title={
          question.stem.length > 90
            ? `${question.stem.slice(0, 90)}…`
            : question.stem
        }
      />
      <QuestionDetail
        question={question}
        subjects={subjects}
        chapters={chapters}
        outcomes={outcomes}
        stats={stats}
      />
    </AppShell>
  );
}
