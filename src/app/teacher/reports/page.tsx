import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listClasses } from "@/core/classes";
import { listReports } from "@/core/reports";
import { can, currentPlan } from "@/core/billing/entitlements";
import { AppShell } from "@/ui/AppShell";
import { Badge, EmptyState, PageHeader } from "@/ui";
import { GenerateReports } from "./GenerateReports";

export const metadata: Metadata = { title: "Reports" };

export const dynamic = "force-dynamic";

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * The academic year so far.
 *
 * The default period, because it is the one a teacher means nine times in ten
 * and typing two dates before you can do anything is how a feature goes unused.
 * India's school year starts in April.
 */
function defaultPeriod(now = new Date()): { start: string; end: string } {
  const year = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 3 ? year : year - 1;
  return {
    start: `${startYear}-04-01`,
    end: now.toISOString().slice(0, 10),
  };
}

export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect("/signin");
  if (session.actor.role === "STUDENT") redirect("/student");
  if (session.actor.role === "PARENT") redirect("/parent");

  const actor = {
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
  };

  const [classes, reports, entitled, plan] = await Promise.all([
    listClasses(actor.organizationId),
    listReports(actor),
    can(actor.organizationId, "parent_reports"),
    currentPlan(actor.organizationId),
  ]);

  // Said before anybody presses anything. The form used to render in full and
  // refuse on submit, which is a button that exists to say no.
  const blocked = entitled.allowed
    ? null
    : entitled.reason === "limit-reached"
      ? `This month's reports on the ${plan?.name ?? "current"} plan are used up.`
      : `Term reports are not included in the ${plan?.name ?? "current"} plan.`;

  const period = defaultPeriod();

  return (
    <AppShell
      fullName={session.fullName}
      organizationName={session.organizationName}
      currentPath="/teacher/reports"
    >
      <PageHeader
        title="Reports"
        description="A term report for one student: what has been measured, how it is going, and what would help. Written once and kept."
      />

      <GenerateReports
        classes={classes.map((klass) => ({
          id: klass.id,
          name: klass.name,
          subjectName: klass.subjectName,
        }))}
        defaultStart={period.start}
        defaultEnd={period.end}
        blocked={blocked}
      />

      {reports.length === 0 ? (
        <EmptyState
          title="No reports yet"
          body="Pick a class and a period above. A student with too little measured is skipped and named — a thin report is worse than none, because it has a date on it and somebody will act on it."
        />
      ) : (
        <>
          <h2 className="ui-section-heading">Written</h2>
          <ul className="ui-report-list">
            {reports.map((report) => (
              <li key={report.id} data-superseded={report.superseded || undefined}>
                <Link href={`/teacher/reports/${report.id}`}>
                  <span className="ui-report-list-name">
                    {report.studentName}
                    {/*
                      Superseded rows stay, and say so. Regenerating writes a
                      new report rather than editing the old one, because "what
                      did we tell this parent in September" is a question
                      somebody asks — and a list of four sheets with no
                      ordering is a list a teacher hands the wrong one from.
                    */}
                    {report.superseded && <Badge tone="neutral">superseded</Badge>}
                  </span>
                  <span className="ui-report-list-meta tabular">
                    {DATE.format(report.periodStart)} – {DATE.format(report.periodEnd)}
                  </span>
                  <span className="ui-report-list-meta tabular">
                    written {DATE.format(report.generatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </AppShell>
  );
}
