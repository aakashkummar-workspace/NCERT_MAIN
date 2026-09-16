import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listAssessments } from "@/core/assessments";
import { listGradesWithSubjects } from "@/core/curriculum";
import { organizationBoardId } from "@/core/organizations";
import { currentAcademicYear } from "@/core/curriculum";
import { listClasses } from "@/core/classes";
import { AppShell } from "@/ui/AppShell";
import { Badge, EmptyState, PageHeader, Stack } from "@/ui";
import { NewAssessment } from "./NewAssessment";

export const metadata: Metadata = { title: "Assessments" };

const STATUS_TONE = {
  DRAFT: "neutral",
  PUBLISHED: "success",
  CLOSED: "neutral",
  ARCHIVED: "neutral",
} as const;

export default async function AssessmentsPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  // The board comes from the organization on the session, never from a
  // parameter. A paper built from another board's grades would be marked
  // against a syllabus this school does not teach.
  const boardId = await organizationBoardId(session.actor.organizationId);

  const [assessments, grades, classes] = await Promise.all([
    listAssessments(session.actor.organizationId),
    listGradesWithSubjects(boardId),
    listClasses(session.actor.organizationId),
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
          />
        }
      />

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
