import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { paperSheet } from "@/core/paper";
import { AppShell } from "@/ui/AppShell";
import { Alert, PageHeader } from "@/ui";
import { PaperEntry } from "./PaperEntry";

export const metadata: Metadata = { title: "Record paper answers" };
export const dynamic = "force-dynamic";

/**
 * Bringing a paper sitting back in — typed, or scanned from the printed
 * answer sheet. See core/paper for what recording does and refuses.
 */
export default async function RecordPaperPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const sheet = await paperSheet(session.actor.organizationId, id);
  if (!sheet) notFound();

  return (
    <AppShell
      currentPath="/teacher/assessments"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href={`/teacher/assignments/${id}`}>{sheet.className}</Link>}
        title="Record paper answers"
        description={`${sheet.title} · ${sheet.subjectName}`}
      />
      {sheet.deliveryMode !== "PAPER" ? (
        <Alert tone="info" title="This paper is sat online">
          Its answers come from the test player, so there is nothing to record by
          hand. A paper is recorded here when it is assigned as &ldquo;sat on paper
          in class&rdquo;.
        </Alert>
      ) : sheet.students.length === 0 ? (
        <Alert tone="info" title="Nobody sits this paper yet">
          Add students to the class first.
        </Alert>
      ) : (
        <PaperEntry initial={sheet} />
      )}
    </AppShell>
  );
}
