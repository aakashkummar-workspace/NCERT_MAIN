import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/core/identity/context";
import { classSetup, getClass } from "@/core/classes";
import { AppShell } from "@/ui/AppShell";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  Badge,
  Card,
  CheckIcon,
  PageHeader,
  PlusIcon,
  SparklesIcon,
  Stack,
} from "@/ui";
import { canPostToClass, listAnnouncementsForClass } from "@/core/announcements";
import { AddStudents } from "./AddStudents";
import { Announcements } from "./Announcements";
import { JoinCode } from "./JoinCode";
import { StudentList } from "./StudentList";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const session = await getSession();
  if (!session) return { title: "Class Overview" };
  const { id } = await params;
  const klass = await getClass(session.actor.organizationId, id);
  return {
    title: klass ? `${klass.name} (${klass.gradeLabel})` : "Class Overview",
  };
}

export default async function ClassPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  const klass = await getClass(session.actor.organizationId, id);
  if (!klass) notFound();

  const [announcements, canPost] = await Promise.all([
    listAnnouncementsForClass(session.actor.organizationId, id),
    canPostToClass(session.actor, id),
  ]);

  const withoutPhone = klass.students.filter((s) => !s.canSignIn).length;
  const hasStudents = klass.students.length > 0;
  const setup = (await classSetup(session.actor.organizationId, id)) ?? {
    hasStudents,
    hasPublishedPaper: false,
    hasAssignment: false,
  };
  // Derived from the rows, one third per milestone. A bar that claimed 66% for
  // a class with students and nothing else was a number nobody had measured.
  const steps = [setup.hasStudents, setup.hasPublishedPaper, setup.hasAssignment];
  const progressPercent = Math.round((steps.filter(Boolean).length / steps.length) * 100);
  const activeStep = steps.findIndex((done) => !done);
  const displaySubject =
    klass.subjectName && !klass.subjectName.startsWith("EMPTY SUBJECT")
      ? klass.subjectName
      : "General";

  return (
    <AppShell
      currentPath="/teacher/classes"
      fullName={session.fullName}
      organizationName={session.organizationName}
      breadcrumbs={[
        { label: "Classes", href: "/teacher/classes" },
        { label: klass.name },
      ]}
      topbarAction={false}
    >
      <PageHeader
        eyebrow={
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              textTransform: "none",
              letterSpacing: "normal",
            }}
          >
            <Badge tone="primary">{klass.gradeLabel}</Badge>
            <Badge tone="neutral">{displaySubject}</Badge>
            <span
              style={{
                fontSize: 12.5,
                color: "var(--text-secondary)",
                fontWeight: 500,
              }}
            >
              Academic Year {klass.academicYear}
            </span>
          </div>
        }
        title={klass.name}
        description={
          hasStudents
            ? `${klass.students.length} ${
                klass.students.length === 1 ? "student enrolled" : "students enrolled"
              } · Ready for syllabus-aligned diagnostic assessments.`
            : "No students enrolled yet. Enrol students below or share the Join Code to begin."
        }
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Link
              href={`/teacher/assessments`}
              className="ui-button"
              data-variant="primary"
              data-size="md"
            >
              <PlusIcon size={15} />
              <span>Create Assessment</span>
            </Link>
            <Link
              href="/teacher/analytics"
              className="ui-button"
              data-variant="secondary"
              data-size="md"
            >
              <SparklesIcon size={15} />
              <span>Class Analytics</span>
            </Link>
          </div>
        }
      />

      <div className="ui-class-layout">
        <Stack>
          {!hasStudents ? (
            <AddStudents classId={klass.id} variant="empty" />
          ) : (
            <>
              {withoutPhone > 0 && (
                <Card>
                  <div className="ui-row" style={{ gap: 12, alignItems: "flex-start" }}>
                    <div style={{ color: "var(--warning)", marginTop: 2 }}>
                      <AlertTriangleIcon size={18} />
                    </div>
                    <div style={{ flex: 1, fontSize: 13.5 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <Badge tone="warning">
                          {withoutPhone} of {klass.students.length} students without mobile
                        </Badge>
                      </div>
                      <span style={{ color: "var(--text-secondary)", lineHeight: 1.4 }}>
                        {withoutPhone === 1
                          ? "One student has no mobile number."
                          : `${withoutPhone} students have no mobile number.`}{" "}
                        A mobile number is the only way a student signs in, so they
                        cannot sit a test until one is added.
                      </span>
                    </div>
                  </div>
                </Card>
              )}
              <StudentList classId={klass.id} students={klass.students} />
              <AddStudents classId={klass.id} variant="collapsed" />
            </>
          )}
        </Stack>

        <Stack>
          <JoinCode classId={klass.id} code={klass.joinCode} className={klass.name} />

          <Announcements
            classId={klass.id}
            className={klass.name}
            items={announcements?.rows ?? []}
            truncated={announcements?.truncated ?? false}
            canPost={canPost}
            now={new Date()}
          />

          {/* Onboarding Quest & Class Next Steps Card */}
          <Card
            title="Setup & Next Steps"
            description="Milestones to launch CBSE diagnostic learning for this class."
          >
            <div className="ui-quest-progress">
              <div className="ui-quest-header">
                <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
                  Setup Progress
                </span>
                <span style={{ fontWeight: 700, color: "var(--accent)" }}>
                  {progressPercent}% Complete
                </span>
              </div>
              <div className="ui-quest-bar-bg">
                <div
                  className="ui-quest-bar-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            <ul className="ui-quest-step-list">
              {/* Step 1 */}
              <li
                className="ui-quest-step-item"
                data-done={hasStudents ? "true" : undefined}
                data-active={!hasStudents ? "true" : undefined}
              >
                <div className="ui-quest-step-icon">
                  {hasStudents ? <CheckIcon size={14} /> : "1"}
                </div>
                <div className="ui-quest-step-content">
                  <div className="ui-quest-step-title">Enrol students</div>
                  <div className="ui-quest-step-desc">
                    {hasStudents
                      ? `${klass.students.length} students enrolled in this roster.`
                      : "Paste student names or share the Access Pass."}
                  </div>
                </div>
              </li>

              {/* Step 2 */}
              <li
                className="ui-quest-step-item"
                data-done={setup.hasPublishedPaper ? "true" : undefined}
                data-active={activeStep === 1 ? "true" : undefined}
              >
                <div className="ui-quest-step-icon">
                  {setup.hasPublishedPaper ? <CheckIcon size={14} /> : "2"}
                </div>
                <div className="ui-quest-step-content">
                  <div className="ui-quest-step-title">Publish an assessment</div>
                  <div className="ui-quest-step-desc">
                    {setup.hasPublishedPaper
                      ? `A ${displaySubject} paper for ${klass.gradeLabel} is published.`
                      : "Choose chapters, set the difficulty mix and pick questions from the bank."}
                  </div>
                  {!setup.hasPublishedPaper && (
                    <Link href="/teacher/assessments" className="ui-quest-step-action">
                      <span>Build assessment</span>
                      <ArrowRightIcon size={12} />
                    </Link>
                  )}
                </div>
              </li>

              {/* Step 3 */}
              <li
                className="ui-quest-step-item"
                data-done={setup.hasAssignment ? "true" : undefined}
                data-active={activeStep === 2 ? "true" : undefined}
              >
                <div className="ui-quest-step-icon">
                  {setup.hasAssignment ? <CheckIcon size={14} /> : "3"}
                </div>
                <div className="ui-quest-step-content">
                  <div className="ui-quest-step-title">Assign it to this class</div>
                  <div className="ui-quest-step-desc">
                    {setup.hasAssignment
                      ? "A paper has been set for this class. Learning gaps appear once answers are marked."
                      : "Set a window for the class to sit it. Marked answers then show learning gaps per concept."}
                  </div>
                </div>
              </li>
            </ul>
          </Card>
        </Stack>
      </div>
    </AppShell>
  );
}
