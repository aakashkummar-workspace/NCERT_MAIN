import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getAssessment, publishCheck } from "@/core/assessments";
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
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  const organizationId = session.actor.organizationId;

  const [assessment, readiness] = await Promise.all([
    getAssessment(organizationId, id),
    publishCheck(organizationId, id),
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
