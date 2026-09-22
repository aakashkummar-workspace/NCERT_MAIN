import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listAssessments } from "@/core/assessments";
import { reviewQueue } from "@/core/assessments/review";
import { listGradesWithSubjects } from "@/core/curriculum";
import { organizationBoardId } from "@/core/organizations";
import { currentAcademicYear } from "@/core/curriculum";
import { listClasses } from "@/core/classes";
import { AppShell } from "@/ui/AppShell";
import { Badge, Card, EmptyState, PageHeader, Stack } from "@/ui";
import { NewAssessment } from "./NewAssessment";

export const metadata: Metadata = { title: "Assessments" };

const STATUS_TONE = {
  DRAFT: "neutral",
  PUBLISHED: "success",
  CLOSED: "neutral",
  ARCHIVED: "neutral",
} as const;

export default async function AssessmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string | string[]; class?: string | string[] }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");
  const query = await searchParams;
  // `?new=1&class=<id>` from a class page opens the form for that class.
  const initialClassId =
    query.new === "1" && typeof query.class === "string" ? query.class : undefined;

  // The board comes from the organization on the session, never from a
  // parameter. A paper built from another board's grades would be marked
  // against a syllabus this school does not teach.
  const boardId = await organizationBoardId(session.actor.organizationId);

  const [assessments, grades, classes, toReview] = await Promise.all([
    listAssessments(session.actor.organizationId),
    listGradesWithSubjects(boardId),
    listClasses(session.actor.organizationId),
    reviewQueue(session.actor),
  ]);

  return (
    <AppShell
      currentPath="/teacher/assessments"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title="Assessments"
        description={
          assessments.length > 0
            ? `${assessments.length} ${assessments.length === 1 ? "assessment" : "assessments"}`
            : undefined
        }
        actions={
          <NewAssessment
            grades={grades}
            classes={classes.map((klass) => ({
              id: klass.id,
              name: klass.name,
              gradeNumber: klass.gradeNumber,
              subjectName: klass.subjectName,
            }))}
            academicYear={currentAcademicYear()}
            initialClassId={initialClassId}
          />
        }
      />

      {/* Owners and admins, when the school checks papers before publishing. */}
      {toReview.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Card
            title={`Waiting for review (${toReview.length})`}
            description="Papers a colleague has sent to be checked before a class sits them."
          >
            <ul className="ui-reteach-list">
              {toReview.map((row) => (
                <li key={row.id}>
                  <Link href={`/teacher/assessments/${row.id}/review`}>{row.title}</Link>
                  <span className="ui-hint">
                    {" "}
                    · {row.gradeLabel} {row.subjectName} · from{" "}
                    {row.mine ? "you (another owner or admin must review it)" : row.authorName}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {assessments.length === 0 ? (
        <EmptyState
          icon="◳"
          title="No assessments yet"
          body="An assessment is a paper you build once and can give to any class. You choose what it covers, the shape of the questions, and which ones go in — then publish it, which freezes the wording so a paper a class has sat can never change underneath them."
          actions={
            <NewAssessment
              grades={grades}
              classes={classes.map((klass) => ({
                id: klass.id,
                name: klass.name,
                gradeNumber: klass.gradeNumber,
                subjectName: klass.subjectName,
              }))}
              academicYear={currentAcademicYear()}
              label="Build your first assessment"
            />
          }
        />
      ) : (
        <Stack>
          <ul className="ui-assessment-list">
            {assessments.map((assessment) => (
              <li key={assessment.id}>
                <Link href={`/teacher/assessments/${assessment.id}`}>
                  <span className="ui-assessment-title">{assessment.title}</span>
                  <span className="ui-assessment-meta">
                    <Badge tone={STATUS_TONE[assessment.status] ?? "neutral"}>
                      {assessment.status.charAt(0) +
                        assessment.status.slice(1).toLowerCase()}
                    </Badge>
                    <span>
                      {assessment.gradeLabel} · {assessment.subjectName}
                    </span>
                    <span className="tabular">
                      {assessment.questionCount}{" "}
                      {assessment.questionCount === 1 ? "question" : "questions"}
                    </span>
                    <span className="tabular">{assessment.totalMarks} marks</span>
                    <span className="tabular">
                      {assessment.durationMinutes} min
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Stack>
      )}
    </AppShell>
  );
}
