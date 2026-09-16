import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listClasses } from "@/core/classes";
import { AppShell } from "@/ui/AppShell";
import { EmptyState, PageHeader } from "@/ui";

export const metadata: Metadata = { title: "Analytics" };

export const dynamic = "force-dynamic";

export default async function AnalyticsIndex() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const classes = await listClasses(session.actor.organizationId);

  return (
    <AppShell
      currentPath="/teacher/analytics"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title="Analytics"
        description="What each class knows, concept by concept — drawn from every marked answer, not from the last test."
      />

      {classes.length === 0 ? (
        <EmptyState
          title="No classes yet"
          body="Analytics reads from marked answers. Add a class, assign a paper, and this fills in once the papers come back."
        />
      ) : (
        <ul className="ui-analytics-classes">
          {classes.map((klass) => (
            <li key={klass.id}>
              <Link href={`/teacher/analytics/${klass.id}`}>
                <span className="ui-analytics-class-name">{klass.name}</span>
                <span className="ui-analytics-class-meta">
                  {klass.subjectName} · {klass.gradeLabel} ·{" "}
                  {klass.studentCount}{" "}
                  {klass.studentCount === 1 ? "student" : "students"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
