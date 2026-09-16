import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listClasses } from "@/core/classes";
import { AppShell } from "@/ui/AppShell";
import { Badge, EmptyState, PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "My Classes" };

export default async function ClassesPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const classes = await listClasses(session.actor.organizationId);

  return (
    <AppShell
      currentPath="/teacher/classes"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title="My Classes"
        description={
          classes.length > 0
            ? `${classes.length} ${classes.length === 1 ? "class" : "classes"} this year.`
            : undefined
        }
        actions={
          <Link
            href="/teacher/classes/new"
            className="ui-button"
            data-variant="primary"
            data-size="md"
          >
            <span>Create a class</span>
          </Link>
        }
      />

      {classes.length === 0 ? (
        <EmptyState
          icon="◫"
          title="You have not created a class yet"
          body="A class is a group you teach — Class 10-A Mathematics, say. Once one exists you can add students, build assessments against your board's syllabus, and see which concepts the group has actually secured."
          actions={
            <Link
              href="/teacher/classes/new"
              className="ui-button"
              data-variant="primary"
              data-size="md"
            >
              <span>Create your first class</span>
            </Link>
          }
        />
      ) : (
        <Stack>
          <div className="ui-class-grid">
            {classes.map((klass) => (
              <Link key={klass.id} href={`/teacher/classes/${klass.id}`} className="ui-class-card">
                <div className="ui-class-card-top">
                  <span className="ui-class-name">{klass.name}</span>
                  {klass.status === "ARCHIVED" && (
                    <Badge tone="neutral">Archived</Badge>
                  )}
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
        </Stack>
      )}
    </AppShell>
  );
}
