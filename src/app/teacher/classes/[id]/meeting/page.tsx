import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { getClass } from "@/core/classes";
import { meetingBrief } from "@/core/reports";
import { brandFor } from "@/app/_branding/surface";
import { PrintButton } from "@/app/teacher/reports/PrintButton";
import { AppShell } from "@/ui/AppShell";
import { Alert, PageHeader } from "@/ui";
import { MeetingSheet } from "../../../_meeting/MeetingSheet";
import { meetingPeriod } from "../../../_meeting/period";

export const metadata: Metadata = { title: "Meeting briefs" };
export const dynamic = "force-dynamic";

/**
 * Every child in a class, one page each — the stack a teacher carries into a
 * PTM day. Built one student at a time, in roll order.
 */
export default async function ClassMeetingPage({
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

  const [klass, brand] = await Promise.all([
    getClass(session.actor.organizationId, id),
    brandFor(session.actor.organizationId),
  ]);
  if (!klass) notFound();

  const students = [...klass.students].sort(
    (a, b) =>
      (a.rollNumber ?? "").localeCompare(b.rollNumber ?? "", undefined, { numeric: true }) ||
      a.fullName.localeCompare(b.fullName),
  );
  const briefs = [];
  for (const student of students) {
    const brief = await meetingBrief(session.actor, student.userId, period.start, period.end);
    if (brief) briefs.push({ id: student.userId, brief });
  }

  return (
    <AppShell currentPath="/teacher/classes" fullName={session.fullName} organizationName={session.organizationName}>
      <PageHeader
        eyebrow={<Link href={`/teacher/classes/${id}`}>{klass.name}</Link>}
        title="Parent–teacher meeting briefs"
        description={`One page per student, ${briefs.length} in all. Built from the evidence as it stands today.`}
      />
      <div className="ui-meeting-actions">
        <PrintButton />
      </div>
      {briefs.length === 0 ? (
        <Alert tone="info" title="Nobody in this class yet">Add students first.</Alert>
      ) : (
        briefs.map(({ id: studentId, brief }) => (
          <MeetingSheet key={studentId} brief={brief} schoolName={brand?.name ?? session.organizationName} />
        ))
      )}
    </AppShell>
  );
}
