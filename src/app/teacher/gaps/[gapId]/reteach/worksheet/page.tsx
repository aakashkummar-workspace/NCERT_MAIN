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
import { PaperSheet } from "@/ui/PaperSheet";

export const metadata: Metadata = { title: "Worksheet" };
export const dynamic = "force-dynamic";

/**
 * The sheet a class holds while an idea is retaught. No answers on it — the
 * key is its own page, for the reason a paper's is. The question list travels
 * in the URL so the key prints exactly these; each id is checked against the
 * concept before anything is shown.
 */
export default async function WorksheetPage({
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
        eyebrow={<Link href={`/teacher/gaps/${gapId}/reteach`}>Reteach brief</Link>}
        title="Worksheet"
      />
      {questions.length === 0 ? (
        <Alert tone="warning" title="No questions for this worksheet">
          There are no approved questions on this idea to print.
        </Alert>
      ) : (
        <>
          <div className="ui-paper-actions">
            <PrintButton />
            <Link
              href={`/teacher/gaps/${gapId}/reteach/worksheet/key?q=${questions.length > 0 ? ids.join(",") : ""}`}
              className="ui-button"
              data-variant="secondary"
              data-size="md"
            >
              <span>Answer key</span>
            </Link>
          </div>
          <PaperSheet
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
            // Named field by field: nothing about the answer reaches the
            // class's sheet by being forgotten in a spread.
            questions={questions.map((question) => ({
              position: question.position,
              number: question.number,
              section: null,
              choiceGroup: null,
              marks: question.marks,
              type: question.type,
              stem: question.stem,
              options: question.options,
            }))}
            instructions="This is practice, not a test. Easier questions come first."
          />
        </>
      )}
    </AppShell>
  );
}
