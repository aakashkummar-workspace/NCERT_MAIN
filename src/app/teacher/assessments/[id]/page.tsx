import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getAssessment, publishCheck } from "@/core/assessments";
import { reviewState } from "@/core/assessments/review";
import { listQuestions } from "@/core/questions";
import { cachedPickerOptions } from "@/app/_curriculum/picker";
import { listAssignments } from "@/core/assignments";
import { listClasses } from "@/core/classes";
import { AppShell } from "@/ui/AppShell";
import { Badge, PageHeader } from "@/ui";
import { Builder } from "./Builder";
import { AssignPanel } from "./AssignPanel";

export const metadata: Metadata = { title: "Assessment" };

export default async function AssessmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ class?: string | string[]; opens?: string | string[]; closes?: string | string[] }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  const query = await searchParams;
  const organizationId = session.actor.organizationId;

  const [assessment, readiness, review] = await Promise.all([
    getAssessment(organizationId, id),
    publishCheck(organizationId, id),
    reviewState(organizationId, id),
  ]);
  if (!assessment) notFound();

  const [picker, bank, classes, assignments] = await Promise.all([
    cachedPickerOptions(),
    // Only approved questions can go into a paper, so only those are offered.
    listQuestions(organizationId, {
      subjectId: assessment.subjectId,
      status: "APPROVED",
      // The whole subject, not the default page: Class 10 Maths alone holds
      // about 850 approved questions, and a picker that silently offers the
      // newest 500 hides a third of the bank from the paper being built.
      limit: 2000,
    }),
    listClasses(organizationId),
    listAssignments(organizationId, { assessmentId: id }),
  ]);

  // Only this paper's subject. The picker covers the whole board — 105
  // chapters across two years and every subject — and offering all of it at
  // step 2 put Class 9 History under a Class 10 Maths paper. The picker is
  // already in syllabus order, so the chapters arrive by number.
  const chapters = picker.chapters.filter(
    (chapter) => chapter.subjectId === assessment.subjectId,
  );
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));
  const outcomes = picker.outcomes.filter((outcome) => chapterIds.has(outcome.chapterId));

  // Only classes that study this subject can sit this paper, so the mismatch
  // the server refuses cannot be chosen in the first place.
  const eligibleClasses = classes.filter(
    (klass) =>
      klass.subjectName === assessment.subjectName &&
      klass.gradeLabel === assessment.gradeLabel,
  );

  return (
    <AppShell
      currentPath="/teacher/assessments"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={
          <>
            <Link href="/teacher/assessments">Assessments</Link> ·{" "}
            {assessment.gradeLabel} {assessment.subjectName}
          </>
        }
        title={assessment.title}
        description={`${assessment.durationMinutes} minutes · ${assessment.totalMarks} marks`}
        actions={
          <div className="ui-row" style={{ gap: 10, alignItems: "center" }}>
            {/* Printing needs the frozen versions, so it is offered only once
                they exist — a published paper. */}
            {assessment.status !== "DRAFT" && (
              <Link
                href={`/teacher/assessments/${assessment.id}/print`}
                className="ui-button"
                data-variant="secondary"
                data-size="sm"
              >
                <span>Print paper</span>
              </Link>
            )}
            <Badge
            tone={
              assessment.status === "PUBLISHED"
                ? "success"
                : assessment.status === "CLOSED"
                  ? "neutral"
                  : "neutral"
            }
          >
            {assessment.status.charAt(0) +
              assessment.status.slice(1).toLowerCase()}
            </Badge>
          </div>
        }
      />

      {assessment.status === "PUBLISHED" && (
        <div style={{ marginBottom: 20 }}>
          <AssignPanel
            assessmentId={assessment.id}
            durationMinutes={assessment.durationMinutes}
            classes={eligibleClasses.map((klass) => ({
              id: klass.id,
              name: klass.name,
              studentCount: klass.studentCount,
            }))}
            requested={requestedWindow(query, eligibleClasses.map((klass) => klass.id), assessment.durationMinutes)}
            existing={assignments.map((assignment) => ({
              id: assignment.id,
              className: assignment.className,
              opensAt: assignment.opensAt.toISOString(),
              closesAt: assignment.closesAt.toISOString(),
              status: assignment.status,
              targetedCount: assignment.targetedCount,
              classSize: assignment.classSize,
            }))}
          />
        </div>
      )}

      <Builder
        assessment={{ ...assessment, readiness }}
        review={
          review.required
            ? {
                required: true,
                status: review.status,
                note: review.note,
                reviewerName: review.reviewerName,
              }
            : { required: false }
        }
        chapters={chapters}
        outcomes={outcomes}
        bank={bank.map((question) => ({
          id: question.id,
          stem: question.stem,
          type: question.type,
          difficulty: question.difficulty,
          marks: question.marks,
          outcomeCount: question.outcomeCount,
          outcomeIds: question.outcomeIds,
          chapterId: question.chapterId,
          chapterNumber: question.chapterNumber,
          chapterTitle: question.chapterTitle,
        }))}
      />
    </AppShell>
  );
}

/**
 * The window and class a paper drafted from a sentence asked for, carried in
 * the URL to the assign panel. It came from a URL, so it is checked, not
 * trusted: real instants, still in the future, long enough for the paper, and
 * a class this paper can actually be assigned to — otherwise the panel falls
 * back to its own suggestion. It is only ever a starting value.
 */
function requestedWindow(
  query: { class?: string | string[]; opens?: string | string[]; closes?: string | string[] },
  eligibleClassIds: string[],
  durationMinutes: number,
): { classId: string | null; opensAt: string; closesAt: string } | null {
  if (typeof query.opens !== "string" || typeof query.closes !== "string") return null;
  const opensAt = new Date(query.opens);
  const closesAt = new Date(query.closes);
  if (Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime())) return null;
  const start = Math.max(opensAt.getTime(), Date.now());
  if (closesAt.getTime() - start < durationMinutes * 60_000) return null;
  const classId = typeof query.class === "string" && eligibleClassIds.includes(query.class) ? query.class : null;
  return { classId, opensAt: new Date(start).toISOString(), closesAt: closesAt.toISOString() };
}
