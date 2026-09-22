import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { gapHeading, worksheetQuestions } from "@/core/gaps/reteach";
import { brandFor } from "@/app/_branding/surface";
import { PrintButton } from "@/app/teacher/reports/PrintButton";
import { AppShell } from "@/ui/AppShell";
import { Alert, PageHeader } from "@/ui";
import { AnswerKeySheet } from "@/ui/PaperSheet";

export const metadata: Metadata = { title: "Worksheet key" };
export const dynamic = "force-dynamic";

/** The teacher's copy of a reteach worksheet: answers and explanations. */
export default async function WorksheetKeyPage({
  params,
  searchParams,
}: {
  params: Promise<{ gapId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");
  const { gapId } = await params;
  if (!z.uuid().safeParse(gapId).success) notFound();
  const ids = ((await searchParams).q ?? "").split(",").filter((id) => z.uuid().safeParse(id).success).slice(0, 20);

  const heading = await gapHeading(session.actor.organizationId, gapId);
  if (!heading) notFound();
  const [questions, brand] = await Promise.all([
    worksheetQuestions(session.actor.organizationId, heading.conceptId, ids),
    brandFor(session.actor.organizationId),
  ]);

  return (
    <AppShell currentPath="/teacher/analytics" fullName={session.fullName} organizationName={session.organizationName}>
      <PageHeader
        eyebrow={<Link href={`/teacher/gaps/${gapId}/reteach/worksheet?q=${ids.join(",")}`}>Worksheet</Link>}
        title="Worksheet key"
      />
      {questions.length === 0 ? (
        <Alert tone="warning" title="No questions">There is nothing on this worksheet.</Alert>
      ) : (
        <>
          <div className="ui-paper-actions">
            <PrintButton />
          </div>
          <AnswerKeySheet
            header={{
              schoolName: brand?.name ?? session.organizationName,
              logoUrl: brand?.logoUrl ?? null,
              title: `Worksheet: ${heading.conceptName}`,
              subjectName: heading.className,
              gradeLabel: "Practice",
              className: null,
              durationMinutes: 0,
              totalMarks: 0,
              questionMarks: 0,
              worksheet: true,
            }}
            questions={questions}
          />
        </>
      )}
    </AppShell>
  );
}
