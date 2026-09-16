import { brandedPageMetadata } from "@/app/_branding/surface";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/core/identity/context";
import { listClasses } from "@/core/classes";
import { listAssessments } from "@/core/assessments";
import { teacherWorkload } from "@/core/results/workload";
import { gapSummary } from "@/core/gaps/read";
import { AppShell } from "@/ui/AppShell";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Row,
  Stack,
  StatCard,
} from "@/ui";
import { ClassesIcon, QuestionsIcon, AssessmentsIcon } from "@/ui/icons";

export const generateMetadata = brandedPageMetadata("Dashboard");

function greeting(now = new Date()): string {
  // IST — the whole customer base is in one timezone, so this is honest rather
  // than a locale guess.
  const hour = (now.getUTCHours() + 5.5) % 24;
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export default async function TeacherDashboard() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const firstName = session.fullName.split(/\s+/)[0] ?? session.fullName;
  const [classes, assessments, workload, gaps] = await Promise.all([
    listClasses(session.actor.organizationId),
    listAssessments(session.actor.organizationId),
    teacherWorkload(session.actor.organizationId),
    gapSummary(session.actor.organizationId),
  ]);
  const high = gaps.gaps.filter((gap) => gap.severity === "HIGH").length;
  const students = classes.reduce((sum, klass) => sum + klass.studentCount, 0);
  const emptyClasses = classes.filter((klass) => klass.studentCount === 0);

  const started = classes.length > 0;

  return (
    <AppShell
      currentPath="/teacher"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={
          started
            ? "Here is where your classes stand."
            : "Nothing needs your attention yet — there is no class data to read. Adding a class is the first step."
        }
        actions={
          <>
            {/*
              A real link. This was a DISABLED button reading "Add a question"
              while /teacher/questions/new was built and working — a control that
              tells a teacher the product cannot do something it can.
            */}
            <Link
              href="/teacher/questions/new"
              className="ui-button"
              data-variant="secondary"
              data-size="md"
            >
              <QuestionsIcon size={16} />
              <span>Add a question</span>
            </Link>
            <Link
              href="/teacher/assessments"
              className="ui-button"
              data-variant="secondary"
              data-size="md"
            >
              <AssessmentsIcon size={16} />
              <span>Assessments</span>
            </Link>
            <Link
              href="/teacher/classes/new"
              className="ui-button"
              data-variant="primary"
              data-size="md"
            >
              <ClassesIcon size={16} />
              <span>Create a class</span>
            </Link>
          </>
        }
      />

      <Stack>
        {!started && (
          <Alert tone="info" title="Start with a class">
            Everything else hangs off it: a class is who a paper is assigned to,
            and who the analytics are about. Add your students once and the rest
            of the product has something to work with.
          </Alert>
        )}

        {/*
          Counts of things a teacher can act on this week, and no score. There
          used to be a "Class mastery" card here that read "not enough evidence
          yet" whatever had happened — false after the first marked paper, and
          had it ever filled in it would have been the single class score the
          product refuses on every other screen.
        */}
        <Grid>
          <StatCard
            label="Students"
            value={students > 0 ? students : undefined}
            context={`In ${classes.length} ${classes.length === 1 ? "class" : "classes"}`}
            empty={students === 0}
            emptyReason={started ? "No students added yet" : "No class yet"}
          />
          <StatCard
            label="Papers to mark"
            value={workload.papersToMark > 0 ? workload.papersToMark : undefined}
            context={`${workload.answersToMark} written ${workload.answersToMark === 1 ? "answer" : "answers"} waiting`}
            empty={workload.papersToMark === 0}
            emptyReason={
              assessments.length === 0 ? "No papers set yet" : "Nothing waiting on you"
            }
          />
          <StatCard
            label="Open now"
            value={workload.open.length > 0 ? workload.open.length : undefined}
            context={`${workload.open.length === 1 ? "Paper" : "Papers"} students can sit today`}
            empty={workload.open.length === 0}
            emptyReason="No paper is open"
          />
          <StatCard
            label="Learning gaps"
            value={gaps.gaps.length > 0 ? gaps.gaps.length : undefined}
            context={
              high > 0
                ? `${high} high severity`
                : "None high severity"
            }
            empty={gaps.gaps.length === 0}
            emptyReason="None found with enough evidence"
          />
        </Grid>

        {(workload.marking.length > 0 ||
          gaps.gaps.length > 0 ||
          gaps.toMeasure.total > 0 ||
          workload.open.length > 0 ||
          workload.released.length > 0) && (
          <Card title="What needs you">
            <ul className="ui-attention">
              {workload.marking.slice(0, 3).map((row) => (
                <li key={`mark-${row.assignmentId}`}>
                  <Badge tone="warning">To mark</Badge>
                  <span>
                    <Link href={`/teacher/assignments/${row.assignmentId}/marking`}>
                      {row.title}
                    </Link>{" "}
                    · {row.className} — {row.answers} written{" "}
                    {row.answers === 1 ? "answer" : "answers"} across {row.papers}{" "}
                    {row.papers === 1 ? "paper" : "papers"}
                  </span>
                </li>
              ))}
              {gaps.gaps.slice(0, 3).map((gap) => (
                <li key={`gap-${gap.id}`}>
                  <Badge tone={gap.severity === "HIGH" ? "danger" : gap.severity === "MEDIUM" ? "warning" : "neutral"}>
                    {gap.status === "PERSISTING"
                      ? "Gap persists"
                      : `${gap.severity[0]}${gap.severity.slice(1).toLowerCase()} gap`}
                  </Badge>
                  <span>
                    <Link href={`/teacher/analytics/${gap.scopeId}/gaps`}>{gap.conceptName}</Link>{" "}
                    · {gap.className} — {gap.affectedStudentCount} of{" "}
                    {gap.measuredStudentCount} measured students below the line
                  </span>
                </li>
              ))}
              {gaps.gaps.length > 3 && (
                <li>
                  <span className="ui-hint">
                    …and {gaps.gaps.length - 3} more{" "}
                    {gaps.gaps.length - 3 === 1 ? "gap" : "gaps"}, on each class&rsquo;s gaps page.
                  </span>
                </li>
              )}
              {gaps.toMeasure.total > 0 && (
                <li>
                  <Badge tone="primary">To measure</Badge>
                  <span>
                    {gaps.toMeasure.total}{" "}
                    {gaps.toMeasure.total === 1 ? "intervention is" : "interventions are"} not
                    measured yet
                    {gaps.toMeasure.onClosedGaps > 0 &&
                      ` — ${gaps.toMeasure.onClosedGaps} on ${gaps.toMeasure.onClosedGaps === 1 ? "a gap that has" : "gaps that have"} already closed`}
                    .{" "}
                    {gaps.toMeasure.classIds.slice(0, 3).map((classId, index) => (
                      <span key={classId}>
                        {index > 0 && " · "}
                        <Link href={`/teacher/analytics/${classId}/gaps`}>
                          {classes.find((klass) => klass.id === classId)?.name ?? "Open the gaps page"}
                        </Link>
                      </span>
                    ))}
                  </span>
                </li>
              )}
              {workload.open.slice(0, 3).map((row) => (
                <li key={`open-${row.assignmentId}`}>
                  <Badge tone="success">Open</Badge>
                  <span>
                    <Link href={`/teacher/assignments/${row.assignmentId}`}>{row.title}</Link>{" "}
                    · {row.className} — {row.submitted} handed in, closes{" "}
                    {new Intl.DateTimeFormat("en-IN", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: "Asia/Kolkata",
                    }).format(row.closesAt)}
                  </span>
                </li>
              ))}
              {workload.released.slice(0, 3).map((row) => (
                <li key={`released-${row.assignmentId}`}>
                  <Badge tone="neutral">Released</Badge>
                  <span>
                    <Link href={`/teacher/assignments/${row.assignmentId}/results`}>{row.title}</Link>{" "}
                    · {row.className} — results released{" "}
                    {new Intl.DateTimeFormat("en-IN", {
                      dateStyle: "medium",
                      timeZone: "Asia/Kolkata",
                    }).format(row.releasedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/*
          The action rule: a number on its own makes the teacher work out what
          to do. An empty class is the one thing here that has an obvious next
          step, so it gets one.
        */}
        {emptyClasses.length > 0 && (
          <Card>
            <Row>
              <Badge tone="warning">Needs attention</Badge>
            </Row>
            <p style={{ margin: "10px 0 0", fontSize: 15, fontWeight: 600 }}>
              {emptyClasses.length === 1
                ? `${emptyClasses[0]!.name} has no students yet`
                : `${emptyClasses.length} classes have no students yet`}
            </p>
            <p
              style={{
                margin: "4px 0 14px",
                fontSize: 14,
                color: "var(--text-secondary)",
                maxWidth: "62ch",
              }}
            >
              A class with no roster cannot be assessed, so nothing downstream
              works until it has one. Pasting a list of names takes about a
              minute.
            </p>
            <Row>
              {emptyClasses.slice(0, 3).map((klass) => (
                <Link
                  key={klass.id}
                  href={`/teacher/classes/${klass.id}`}
                  className="ui-button"
                  data-variant="primary"
                  data-size="sm"
                >
                  <span>Add students to {klass.name}</span>
                </Link>
              ))}
            </Row>
          </Card>
        )}

        {started ? (
          <Card
            title="Your classes"
            action={
              <Link
                href="/teacher/classes"
                className="ui-button"
                data-variant="ghost"
                data-size="sm"
              >
                <span>View all</span>
              </Link>
            }
          >
            <div className="ui-class-grid">
              {classes.slice(0, 6).map((klass) => (
                <Link
                  key={klass.id}
                  href={`/teacher/classes/${klass.id}`}
                  className="ui-class-card"
                >
                  <div className="ui-class-card-top">
                    <span className="ui-class-name">{klass.name}</span>
                  </div>
                  <span className="ui-class-meta">
                    {klass.gradeLabel} · {klass.subjectName}
                  </span>
                  <div className="ui-class-foot">
                    <span className="ui-class-count tabular">
                      {klass.studentCount}
                    </span>
                    <span className="ui-class-count-label">
                      {klass.studentCount === 1 ? "student" : "students"}
                    </span>
                    <span className="ui-class-year">{klass.academicYear}</span>
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        ) : (
          <EmptyState
            icon={<ClassesIcon size={24} />}
            title="Your first class is the next step"
            body="Once a class exists you can add students by pasting a list, uploading a CSV, or sharing a join code — and then build your first assessment against your board's syllabus."
            actions={
              <Link
                href="/teacher/classes/new"
                className="ui-button"
                data-variant="primary"
                data-size="md"
              >
                <ClassesIcon size={16} />
                <span>Create a class</span>
              </Link>
            }
          />
        )}

        <Card
          title="Why some numbers show “—” and not “0%”"
          description="A design rule you will see throughout the product."
        >
          <p
            style={{
              margin: 0,
              fontSize: 14,
              color: "var(--text-secondary)",
              maxWidth: "68ch",
            }}
          >
            Zero and &ldquo;no data yet&rdquo; mean opposite things to a teacher,
            and only one of them is a reason to change a lesson plan. Wherever
            this product cannot stand behind a number, it shows you that instead
            of inventing one. The same rule governs concept mastery: below a
            minimum amount of evidence you will see{" "}
            <em>not enough evidence yet</em>, never a percentage.
          </p>
        </Card>
      </Stack>
    </AppShell>
  );
}
