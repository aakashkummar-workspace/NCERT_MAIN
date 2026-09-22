import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { meetingBrief } from "@/core/reports";
import { brandFor } from "@/app/_branding/surface";
import { PrintButton } from "@/app/teacher/reports/PrintButton";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui";
import { MeetingSheet } from "../../../_meeting/MeetingSheet";
import { meetingPeriod } from "../../../_meeting/period";

export const metadata: Metadata = { title: "Meeting brief" };
export const dynamic = "force-dynamic";

/** One child's parent–teacher meeting brief. See core/reports/meeting.ts. */
export default async function StudentMeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const period = meetingPeriod((await searchParams).from);

  const [brief, brand] = await Promise.all([
    meetingBrief(session.actor, id, period.start, period.end),
    brandFor(session.actor.organizationId),
  ]);
  if (!brief) notFound();

  return (
    <AppShell currentPath="/teacher/students" fullName={session.fullName} organizationName={session.organizationName}>
      <PageHeader
        eyebrow={<Link href={`/teacher/students/${id}`}>{brief.studentName}</Link>}
        title="Parent–teacher meeting"
        description="Built from the evidence as it stands today, and stored nowhere. Print it for the meeting."
      />
      <div className="ui-meeting-actions">
        <PrintButton />
      </div>
      <MeetingSheet brief={brief} schoolName={brand?.name ?? session.organizationName} />
    </AppShell>
  );
}
