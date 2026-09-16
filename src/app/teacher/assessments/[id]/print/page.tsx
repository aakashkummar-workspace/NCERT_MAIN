import Link from "next/link";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { paperForPrint } from "@/core/assessments/paper";
import { brandFor } from "@/app/_branding/surface";
import { AppShell } from "@/ui/AppShell";
import { Alert, PageHeader } from "@/ui";
import { PaperSheet } from "@/ui/PaperSheet";
import { PrintButton } from "@/app/teacher/reports/PrintButton";

export const metadata: Metadata = { title: "Print paper" };

export const dynamic = "force-dynamic";

/**
 * The question paper, for a printer.
 *
 * The print stylesheet IS the download, exactly as with a term report: a
 * browser's Save-as-PDF produces a file on every device, respects the reader's
 * own settings, and needs no server dependency.
 *
 * It prints the FROZEN versions, so a draft is refused rather than printed
 * from the live wording — see core/assessments/paper.ts.
 */
export default async function PrintPaperPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");
  if (session.actor.role === "STUDENT") redirect("/student");
  if (session.actor.role === "PARENT") redirect("/parent");

  const { id } = await params;
  // A malformed id is a page that does not exist, not a database error.
  if (!z.uuid().safeParse(id).success) notFound();

  const [result, brand] = await Promise.all([
    paperForPrint(session.actor.organizationId, id),
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
        eyebrow={<Link href={`/teacher/assessments/${id}`}>Assessment</Link>}
        title="Print paper"
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
              href={`/teacher/assessments/${id}/print/key`}
              className="ui-button"
              data-variant="secondary"
              data-size="md"
            >
              <span>Answer key</span>
            </Link>
          </div>
          <p className="ui-paper-note">
            This is the paper as it was published, not as the questions read
            today — so a question edited since is still printed the way the
            class will be marked against. The answer key is a separate page, on
            purpose.
          </p>

          <PaperSheet
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
            questions={result.paper.questions}
          />
        </>
      )}
    </AppShell>
  );
}
