import Link from "next/link";
import { bookLinksForConcepts } from "@/core/curriculum/book-links";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getPractice } from "@/core/practice";
import { tutorOffered } from "@/core/tutor";
import { savedQuestionIds } from "@/core/saved";
import { StudentShell } from "@/ui/StudentShell";
import { PageHeader } from "@/ui";
import { Runner } from "./Runner";

export const metadata: Metadata = { title: "Practice" };

export const dynamic = "force-dynamic";

export default async function PracticeSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const { sessionId } = await params;
  const practice = await getPractice(
    {
      organizationId: session.actor.organizationId,
      userId: session.actor.userId,
    },
    sessionId,
  );
  if (!practice) notFound();

  const [helpOffered, saved, books] = await Promise.all([
    tutorOffered(session.actor.organizationId),
    savedQuestionIds(
      session.actor.organizationId,
      session.actor.userId,
      practice.questions.map((question) => question.questionId),
    ),
    bookLinksForConcepts(practice.conceptId ? [practice.conceptId] : [], "student"),
  ]);
  const book = books.get(practice.conceptId);

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/student/practice">Practice</Link>}
        title={practice.conceptName}
      />

      <Runner
        sessionId={practice.sessionId}
        conceptName={practice.conceptName}
        questionCount={practice.questionCount}
        helpOffered={helpOffered}
        savedQuestionIds={[...saved]}
        questions={practice.questions.map((question) => ({
          practiceAnswerId: question.practiceAnswerId,
          questionId: question.questionId,
          position: question.position,
          type: question.type,
          stem: question.stem,
          options: question.options,
          response: question.response,
          isCorrect: question.isCorrect,
          explanation: question.explanation,
          correctAnswer: question.correctAnswer,
          correctKeys: question.correctKeys,
        }))}
      />

      {/* The book, not the answer — so it can sit here from the start. */}
      {book && (
        <p className="ui-hint" style={{ marginTop: 16 }}>
          This idea is in your book: <Link href={book.href}>{book.label}</Link>
        </p>
      )}
    </StudentShell>
  );
}
