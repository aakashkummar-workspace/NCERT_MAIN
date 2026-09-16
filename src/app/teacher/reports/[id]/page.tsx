import { z } from "zod";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getReport } from "@/core/reports";
import { logoUrl } from "@/core/branding";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui";
import { ReportSheet, type ReportSheetPayload } from "@/ui/ReportSheet";
import { PrintButton } from "../PrintButton";

export const metadata: Metadata = { title: "Report" };

export const dynamic = "force-dynamic";

export default async function ReportPage({
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
  const report = await getReport(
    {
      organizationId: session.actor.organizationId,
      userId: session.actor.userId,
    },
    id,
  );
  if (!report) notFound();

  return (
    <AppShell
      fullName={session.fullName}
      organizationName={session.organizationName}
      currentPath="/teacher/reports"
    >
      <PageHeader
        eyebrow={<Link href="/teacher/reports">Reports</Link>}
        title={report.payload.studentName}
      />

      {/*
        The print control is the download. A browser's "Save as PDF" produces a
        file on every device including the phone a parent is holding, respects
        the reader's own font size, and needs no server dependency — and the
        print stylesheet has to exist either way for the sheet to survive being
        printed at all.
      */}
      <div className="ui-report-actions">
        <PrintButton />
      </div>

      <ReportSheet
        payload={report.payload as unknown as ReportSheetPayload}
        payloadVersion={report.payloadVersion}
        generatedAt={report.generatedAt}
        organizationName={session.organizationName}
        letterhead={report.letterhead}
        letterheadLogoUrl={report.letterhead?.logoId ? logoUrl(report.letterhead.logoId) : null}
      />
    </AppShell>
  );
}
