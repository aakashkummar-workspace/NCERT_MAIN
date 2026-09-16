import { z } from "zod";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getAssignment } from "@/core/assignments";
import { describeWindow } from "@/core/assignments/window";
import { AppShell } from "@/ui/AppShell";
import { Badge, Card, PageHeader, Stack, type Tone } from "@/ui";
import { AssignmentActions } from "./AssignmentActions";

export const metadata: Metadata = { title: "Assignment" };

const STATUS_TONE: Record<string, Tone> = {
  SCHEDULED: "primary",
  OPEN: "success",
  CLOSED: "neutral",
  CANCELLED: "neutral",
};

const SITTER_TONE: Record<string, Tone> = {
  NOT_STARTED: "neutral",
  IN_PROGRESS: "primary",
  SUBMITTED: "success",
  EXPIRED: "warning",
};

/**
 * "Ran out of time" and "handed it in" are different facts about a student,
 * and a teacher scanning this list is looking for exactly that difference.
 */
const SITTER_LABEL: Record<string, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "Sitting now",
  SUBMITTED: "Submitted",
  EXPIRED: "Ran out of time",
};

const POLICY_LABEL: Record<string, string> = {
  IMMEDIATE: "Straight away",
  AFTER_CLOSE: "After the window closes",
  MANUAL: "When you release them",
};

export default async function AssignmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  // A malformed id is a page that does not exist, not a database error.
  if (!z.uuid().safeParse(id).success) notFound();
  const assignment = await getAssignment(session.actor.organizationId, id);
  if (!assignment) notFound();

  const cannotSignIn = assignment.students.filter((s) => !s.canSignIn).length;

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
            <Link href={`/teacher/assessments/${assignment.assessmentId}`}>
              {assignment.assessmentTitle}
            </Link>
          </>
        }
        title={assignment.className}
        description={`${assignment.questionCount} questions · ${assignment.totalMarks} marks · ${assignment.durationMinutes} minutes`}
        actions={
          <Badge tone={STATUS_TONE[assignment.status] ?? "neutral"}>
            {assignment.status.charAt(0) +
              assignment.status.slice(1).toLowerCase()}
          </Badge>
        }
      />

      <div className="ui-class-layout">
        <Stack>
          {cannotSignIn > 0 && (
            <Card>
              <div className="ui-row" style={{ gap: 12 }}>
                <Badge tone="warning">
                  {cannotSignIn} of {assignment.students.length}
                </Badge>
                <span style={{ fontSize: 14 }}>
                  <strong>
                    {cannotSignIn === 1
                      ? "One student has no mobile number."
                      : `${cannotSignIn} students have no mobile number.`}
                  </strong>{" "}
                  <span style={{ color: "var(--text-secondary)" }}>
                    They cannot receive a sign-in code, so they cannot sit this.
                    Add numbers before the window opens.
                  </span>
                </span>
              </div>
            </Card>
          )}

          <Card
            title={`Who sits this (${assignment.students.length})`}
            description={
              assignment.wholeClass
                ? "The whole class, including anyone who joins before the window opens."
                : "A chosen group, not the whole class."
            }
          >
            {assignment.students.length === 0 ? (
              <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>
                Nobody is in this class yet, so nobody would receive it.
              </p>
            ) : (
              <ul className="ui-sitter-list">
                {assignment.students.map((student) => (
                  <li key={student.userId}>
                    <span className="ui-sitter-name">{student.fullName}</span>
                    {!student.canSignIn ? (
                      <Badge tone="warning">No mobile</Badge>
                    ) : (
                      <Badge tone={SITTER_TONE[student.attemptStatus]}>
                        {SITTER_LABEL[student.attemptStatus]}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="ui-hint" style={{ marginTop: 14 }}>
              <Link href={`/teacher/assignments/${assignment.id}/results`}>
                See the results
              </Link>{" "}
              for scores, marking and question-by-question analysis.
            </p>
          </Card>
        </Stack>

        <Stack>
          <Card title="The window">
            <p className="ui-window-headline">
              {describeWindow({
                opensAt: assignment.opensAt,
                closesAt: assignment.closesAt,
                cancelledAt: assignment.cancelledAt,
              })}
            </p>
            <dl className="ui-facts">
              <dt>Opens</dt>
              <dd>{formatWhen(assignment.opensAt)}</dd>
              <dt>Closes</dt>
              <dd>{formatWhen(assignment.closesAt)}</dd>
              <dt>Duration</dt>
              <dd className="tabular">{assignment.durationMinutes} min</dd>
              <dt>Attempts</dt>
              <dd className="tabular">{assignment.maxAttempts}</dd>
              <dt>Results</dt>
              <dd>{POLICY_LABEL[assignment.resultsPolicy] ?? assignment.resultsPolicy}</dd>
            </dl>
          </Card>

          <AssignmentActions
            assignmentId={assignment.id}
            status={assignment.status}
          />
        </Stack>
      </div>
    </AppShell>
  );
}

/**
 * Rendered on the server in IST, because the whole customer base is in one
 * zone and a timestamp that shifts between server and browser is worse than
 * one that is simply stated.
 */
function formatWhen(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(date);
}
