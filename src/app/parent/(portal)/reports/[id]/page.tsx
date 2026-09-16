import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { childReport } from "@/core/parent/read";
import { logoUrl } from "@/core/branding";
import { ParentShell } from "@/ui/ParentShell";
import { PageHeader } from "@/ui";
import { ReportSheet, type ReportSheetPayload } from "@/ui/ReportSheet";
import { PrintButton } from "../PrintButton";

export const metadata: Metadata = { title: "Report" };

export const dynamic = "force-dynamic";

export default async function ParentReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");

  const { id } = await params;
  // The consent check runs on the CHILD the report is about, resolved from the
  // row rather than taken from the URL — a report id is not a capability.
  const report = await childReport(
    {
      organizationId: session.actor.organizationId,
      userId: session.actor.userId,
    },
    id,
  );
  if (!report) notFound();

  return (
    <ParentShell
      fullName={session.fullName}
      organizationName={session.organizationName}

    >
      <PageHeader eyebrow={<Link href="/parent/reports">Reports</Link>} title="Report" />

      <div className="ui-report-actions">
        <PrintButton />
      </div>

      <ReportSheet
        payload={report.payload as ReportSheetPayload}
        payloadVersion={report.payloadVersion}
        generatedAt={report.generatedAt}
        organizationName={session.organizationName}
        superseded={report.superseded}
        letterhead={report.letterhead}
        letterheadLogoUrl={report.letterhead?.logoId ? logoUrl(report.letterhead.logoId) : null}
      />
    </ParentShell>
  );
}
