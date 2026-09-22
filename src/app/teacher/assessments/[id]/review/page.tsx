import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { getAssessment, publishCheck } from "@/core/assessments";
import { draftPreview, reviewQueue, reviewState, REVIEWERS } from "@/core/assessments/review";
import { answerableMarks } from "@/core/assessments/pattern";
import { brandFor } from "@/app/_branding/surface";
import { AppShell } from "@/ui/AppShell";
import { Alert, Badge, PageHeader } from "@/ui";
import { AnswerKeySheet } from "@/ui/PaperSheet";
import { ReviewDecision } from "./ReviewDecision";

export const metadata: Metadata = { title: "Review paper" };
export const dynamic = "force-dynamic";

const STATUS_LABEL = {
  NOT_SENT: "Not sent",
  WAITING: "Waiting",
  CHANGES_REQUESTED: "Changes asked",
  APPROVED: "Approved",
} as const;

/**
 * The reviewer's view of a draft: the whole paper with its answers, what the
 * publish check still objects to, and the decision. See
 * core/assessments/review.ts.
 */
export default async function ReviewPaperPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/signin");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const organizationId = session.actor.organizationId;
  const [assessment, preview, state, check, brand, queue] = await Promise.all([
    getAssessment(organizationId, id),
    draftPreview(organizationId, id),
    reviewState(organizationId, id),
    publishCheck(organizationId, id),
    brandFor(organizationId),
    reviewQueue(session.actor),
  ]);
  if (!assessment) notFound();
  // The author sees the paper and its status, never a form they could only be
  // refused from.
  const mine = queue.find((row) => row.id === id)?.mine ?? false;

  const canDecide =
    REVIEWERS.has(session.actor.role) && state.required && state.status === "WAITING" && !mine;
  // Everything the publish check objects to, except the review itself: that
  // is what the reviewer is here to settle.
  const otherProblems = (check?.problems ?? []).filter((problem) => !/review/i.test(problem));

  return (
    <AppShell
      currentPath="/teacher/assessments"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href={`/teacher/assessments/${id}`}>{assessment.title}</Link>}
        title="Review paper"
        description={`${assessment.gradeLabel} · ${assessment.subjectName} · ${assessment.durationMinutes} minutes · ${assessment.totalMarks} marks`}
        actions={
          state.required ? (
            <Badge
              tone={
                state.status === "APPROVED"
                  ? "success"
                  : state.status === "CHANGES_REQUESTED"
                    ? "warning"
                    : "neutral"
              }
            >
              {STATUS_LABEL[state.status]}
            </Badge>
          ) : undefined
        }
      />

      {!state.required && (
        <Alert tone="info" title="Your school does not review papers">
          Papers are published by their author. An owner or admin can turn review on in Settings.
        </Alert>
      )}

      {otherProblems.length > 0 && (
        <Alert tone="warning" title="The publish check also objects">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {otherProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      )}

      {canDecide && <ReviewDecision assessmentId={id} />}
      {mine && state.required && state.status === "WAITING" && (
        <Alert tone="info" title="Another owner or admin reviews this">
          You wrote this paper, so a colleague has to approve it.
        </Alert>
      )}

      {state.required && state.status !== "WAITING" && state.note && (
        <Alert tone="info" title={`Note from ${state.reviewerName ?? "the reviewer"}`}>
          {state.note}
        </Alert>
      )}

      <AnswerKeySheet
        header={{
          schoolName: brand?.name ?? session.organizationName,
          logoUrl: brand?.logoUrl ?? null,
          title: assessment.title,
          subjectName: assessment.subjectName,
          gradeLabel: assessment.gradeLabel,
          className: assessment.className,
          durationMinutes: assessment.durationMinutes,
          totalMarks: assessment.totalMarks,
          questionMarks: answerableMarks(preview),
        }}
        questions={preview}
      />
    </AppShell>
  );
}
