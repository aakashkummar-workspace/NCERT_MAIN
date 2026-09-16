import { z } from "zod";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { markingQueue } from "@/core/results/marking";
import { AppShell } from "@/ui/AppShell";
import { EmptyState, PageHeader } from "@/ui";
import { MarkingBoard } from "./MarkingBoard";

export const metadata: Metadata = { title: "Marking" };

export const dynamic = "force-dynamic";

export default async function MarkingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  // A malformed id is a page that does not exist, not a database error.
  if (!z.uuid().safeParse(id).success) notFound();
  const queue = await markingQueue(
    {
      organizationId: session.actor.organizationId,
      userId: session.actor.userId,
      role: session.actor.role,
    },
    id,
  );
  if (!queue) notFound();

  return (
    <AppShell
      currentPath="/teacher/assessments"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={
          <Link href={`/teacher/assignments/${id}/results`}>{queue.className}</Link>
        }
        title="Marking"
        description={
          queue.totalUnmarked === 0
            ? "Nothing is waiting on you."
            : `${queue.totalUnmarked} ${queue.totalUnmarked === 1 ? "answer" : "answers"} to mark, grouped by question.`
        }
      />

      {queue.groups.length === 0 ? (
        <EmptyState
          title="Nothing to mark"
          body="Every question on this paper was marked automatically, or nobody has written an answer yet. Objective questions never appear here — they were settled when the paper was submitted."
        />
      ) : (
        <MarkingBoard groups={queue.groups} />
      )}
    </AppShell>
  );
}
