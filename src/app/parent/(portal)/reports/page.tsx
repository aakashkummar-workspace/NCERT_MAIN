import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { childReports, linkedStudents } from "@/core/parent/read";
import { ParentShell } from "@/ui/ParentShell";
import { EmptyState, PageHeader } from "@/ui";

export const metadata: Metadata = { title: "Reports" };

export const dynamic = "force-dynamic";

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * The reports written about this parent's child.
 *
 * Reached through `core/parent/read.ts` and nothing else — an ESLint fence over
 * this whole directory rejects `@/core/reports`, which takes a student id and
 * checks no consent at all.
 */
export default async function ParentReportsPage() {
  const session = await getSession();
  if (!session) redirect("/signin/student");

  const actor = {
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
  };

  const children = await linkedStudents(actor);
  const child = children[0] ?? null;
  const reports = child ? await childReports(actor, child.studentUserId) : [];

  return (
    <ParentShell
      fullName={session.fullName}
      organizationName={session.organizationName}

    >
      <PageHeader
        title="Reports"
        description={
          child
            ? `Term reports for ${child.fullName}, as they were written.`
            : undefined
        }
      />

      {reports.length === 0 ? (
        <EmptyState
          title="No reports yet"
          body="The school writes these at the end of a term. When one is written it will appear here, and it will still say the same thing when you come back to it."
        />
      ) : (
        <ul className="ui-report-list">
          {reports.map((report) => (
            <li key={report.id} data-superseded={report.superseded || undefined}>
              <Link href={`/parent/reports/${report.id}`}>
                <span className="ui-report-list-name">
                  {DATE.format(report.periodStart)} – {DATE.format(report.periodEnd)}
                </span>
                <span className="ui-report-list-meta tabular">
                  written {DATE.format(report.generatedAt)}
                </span>
                {/*
                  Older reports stay readable rather than disappearing. Each one
                  is a true record of what the school said on the day, and a
                  parent who was handed a sheet in September should be able to
                  find that same sheet in December.
                */}
                {report.superseded && (
                  <span className="ui-report-list-meta">a newer one exists</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ParentShell>
  );
}
