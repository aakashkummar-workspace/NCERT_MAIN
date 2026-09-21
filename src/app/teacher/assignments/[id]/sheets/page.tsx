import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { paperSheet } from "@/core/paper";
import { omrLayout } from "@/core/omr/layout";
import { sheetRows } from "@/core/omr/paper";
import { brandFor } from "@/app/_branding/surface";
import { PrintButton } from "@/app/teacher/reports/PrintButton";
import { AppShell } from "@/ui/AppShell";
import { Alert, PageHeader } from "@/ui";
import { OmrSheet } from "./OmrSheet";

export const metadata: Metadata = { title: "Answer sheets" };
export const dynamic = "force-dynamic";

/**
 * One printed answer sheet per student, each carrying its owner in the
 * identity strip — so a pile of scanned sheets sorts itself, whatever order
 * the class handed them in.
 */
export default async function AnswerSheetsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [sheet, brand] = await Promise.all([
    paperSheet(session.actor.organizationId, id),
    brandFor(session.actor.organizationId),
  ]);
  if (!sheet) notFound();

  const { rows, offSheet, overflow } = sheetRows(sheet.questions);
  const layout = omrLayout(rows);

  return (
    <AppShell
      currentPath="/teacher/assessments"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href={`/teacher/assignments/${id}`}>{sheet.className}</Link>}
        title="Answer sheets"
        description={`${sheet.title} · one sheet per student, ${sheet.students.length} in all`}
      />

      <div className="ui-omr-actions">
        {sheet.deliveryMode !== "PAPER" && (
          <Alert tone="warning" title="This paper is sat online">
            Answer sheets are for a paper sat in the room. This one is sat in the
            player, so its answers arrive by themselves.
          </Alert>
        )}
        {rows.length === 0 ? (
          <Alert tone="info" title="Nothing to bubble">
            This paper has no multiple-choice or true/false questions, so there is
            nothing for an answer sheet to hold. Record the marks by hand instead.
          </Alert>
        ) : (
          <>
            <p className="ui-hint" style={{ margin: "0 0 12px" }}>
              Print these and hand each student their own — the name is on it,
              and the strip of squares tells the scanner whose it is.{" "}
              {offSheet.length > 0 &&
                `Questions ${offSheet.join(", ")} are answered on the question paper and entered by hand.`}{" "}
              {overflow > 0 &&
                `${overflow} objective questions did not fit on one sheet and are among those.`}
            </p>
            <div className="ui-row" style={{ gap: 10, flexWrap: "wrap" }}>
              <PrintButton />
              <Link
                href={`/teacher/assignments/${id}/paper`}
                className="ui-button"
                data-variant="secondary"
                data-size="md"
              >
                <span>Record or scan answers</span>
              </Link>
            </div>
          </>
        )}
      </div>

      {rows.length > 0 &&
        sheet.students.map((student) => (
          <OmrSheet
            key={student.userId}
            layout={layout}
            sheetCode={student.sheetCode}
            studentName={student.fullName}
            rollNumber={student.rollNumber}
            title={sheet.title}
            className={sheet.className}
            schoolName={brand?.name ?? session.organizationName}
            offSheet={offSheet}
          />
        ))}
    </AppShell>
  );
}
