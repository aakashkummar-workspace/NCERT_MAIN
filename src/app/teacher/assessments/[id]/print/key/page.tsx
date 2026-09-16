import Link from "next/link";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { answerKeyForPrint } from "@/core/assessments/paper";
import { brandFor } from "@/app/_branding/surface";
import { AppShell } from "@/ui/AppShell";
import { Alert, PageHeader } from "@/ui";
import { AnswerKeySheet } from "@/ui/PaperSheet";
import { PrintButton } from "@/app/teacher/reports/PrintButton";

export const metadata: Metadata = { title: "Answer key" };

export const dynamic = "force-dynamic";

/**
 * The teacher's copy: answers, mark scheme and explanations.
 *
 * A separate page from the paper rather than a toggle on it, because the
 * difference between the two documents is the difference between a sheet a
 * class may hold and one they may not — and the failure mode of getting that
 * wrong is thirty photocopies of the answers.
 */
export default async function PrintAnswerKeyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");
  if (session.actor.role === "STUDENT") redirect("/student");
  if (session.actor.role === "PARENT") redirect("/parent");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const [result, brand] = await Promise.all([
    answerKeyForPrint(session.actor.organizationId, id),
    brandFor(session.actor.organizationId),
  ]);
  if (!result.ok && result.reason === "not-found") notFound();

  return (
    <AppShell
      fullName={session.fullName}
      organizationName={session.organizationName}
      currentPath="/teacher/assessments"
    >
      <PageHeader
        eyebrow={<Link href={`/teacher/assessments/${id}/print`}>Print paper</Link>}
        title="Answer key"
      />

      {!result.ok ? (
        <Alert tone="warning" title="This paper cannot be printed yet">
          {result.message}
        </Alert>
      ) : (
        <>
          <div className="ui-paper-actions">
            <PrintButton />
            <Link
              href={`/teacher/assessments/${id}/print`}
              className="ui-button"
              data-variant="secondary"
              data-size="md"
            >
              <span>Question paper</span>
            </Link>
          </div>

          <AnswerKeySheet
            header={{
              schoolName: brand?.name ?? session.organizationName,
              logoUrl: brand?.logoUrl ?? null,
              title: result.paper.title,
              subjectName: result.paper.subjectName,
              gradeLabel: result.paper.gradeLabel,
              className: result.paper.className,
              durationMinutes: result.paper.durationMinutes,
              totalMarks: result.paper.totalMarks,
              questionMarks: result.paper.questionMarks,
            }}
            questions={result.questions.map((question) => ({
              position: question.position,
              marks: question.marks,
              type: question.type,
              stem: question.stem,
              options: question.options,
              answerLabel: question.answerLabel,
              explanation: question.explanation,
              difficulty: question.difficulty,
              rubric: question.rubric,
            }))}
          />
        </>
      )}
    </AppShell>
  );
}
