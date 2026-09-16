import { brandedPageMetadata } from "@/app/_branding/surface";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/core/identity/context";
import {
  exceptions,
  instituteKpis,
  liveAssignments,
  type Exception,
} from "@/core/institute/kpis";
import { PageHeader, StatCard } from "@/ui";
import {
  contributionState,
  MIN_MEASURED_TO_CONTRIBUTE,
  MIN_SCHOOLS,
} from "@/core/benchmarks";
import { BenchmarkOptIn } from "./BenchmarkOptIn";

export const generateMetadata = brandedPageMetadata("Institute");

export const dynamic = "force-dynamic";

const SEVERITY_LABEL: Record<Exception["severity"], string> = {
  high: "Needs attention today",
  medium: "Worth a look",
};

export default async function InstituteDashboard() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const organizationId = session.actor.organizationId;
  const [kpis, found, live, benchmarks] = await Promise.all([
    instituteKpis(organizationId),
    exceptions(organizationId),
    liveAssignments(organizationId),
    contributionState(organizationId),
  ]);

  const high = found.filter((row) => row.severity === "high");
  const medium = found.filter((row) => row.severity === "medium");

  return (
    <>
      <PageHeader
        title={session.organizationName}
        description={`Across the whole institute, over the last ${kpis.windowDays} days.`}
      />

      {/*
        The exceptions come FIRST, above the counts. An owner does not need to
        be told they have twelve teachers; they need to be told which two have
        papers sitting unmarked a fortnight after the test. PRD: "a dashboard
        with exceptions surfaced".
      */}
      {found.length === 0 ? (
        <p className="ui-exception-none">
          Nothing needs chasing. No overdue marking, every class has had
          something set, and every student can sign in.
        </p>
      ) : (
        <div className="ui-exceptions">
          {[high, medium].map((group, index) =>
            group.length === 0 ? null : (
              <section key={index}>
                <h2 className="ui-section-heading">
                  {SEVERITY_LABEL[group[0]!.severity]}
                </h2>
                <ul className="ui-exception-list">
                  {group.map((row) => (
                    <li
                      key={row.kind}
                      className="ui-exception"
                      data-severity={row.severity}
                    >
                      <span className="ui-exception-body">
                        <span className="ui-exception-subject">{row.subject}</span>
                        <span className="ui-exception-message">{row.message}</span>
                      </span>
                      {/*
                        Every exception links to the place it is fixed. One that
                        cannot be acted on gets ignored, and then so do the
                        others.
                      */}
                      <Link
                        href={row.href}
                        className="ui-button"
                        data-variant="secondary"
                        data-size="sm"
                      >
                        <span>Go there</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ),
          )}
        </div>
      )}

      <h2 className="ui-section-heading" style={{ marginTop: 28 }}>
        The numbers
      </h2>
      <div className="ui-grid">
        <StatCard label="Teachers" value={kpis.teachers} />
        <StatCard label="Students" value={kpis.students} />
        <StatCard label="Classes" value={kpis.classes} />
        <StatCard label="Tests open now" value={live} />
      </div>

      <div className="ui-grid" style={{ marginTop: 12 }}>
        <StatCard
          label="Students who sat something"
          value={kpis.activeStudents}
          // The denominator travels with it. "180 active" means one thing in a
          // centre of 200 and another in a centre of 600.
          context={`of ${kpis.students}, in ${kpis.windowDays} days`}
        />
        <StatCard
          label="Papers published"
          value={kpis.assessmentsPublished}
          context={`in ${kpis.windowDays} days`}
        />
        <StatCard
          label="Papers sat"
          value={kpis.attemptsSubmitted}
          context={`in ${kpis.windowDays} days`}
        />
      </div>

      <div style={{ marginTop: 20 }}>
        <BenchmarkOptIn
          contributing={benchmarks.contributing}
          concepts={benchmarks.concepts}
          minSchools={MIN_SCHOOLS}
          minStudents={MIN_MEASURED_TO_CONTRIBUTE}
        />
      </div>

      <p className="ui-hint" style={{ marginTop: 20 }}>
        {/*
          Said out loud on the owner's own page, because this is where the
          request for a league table arrives — about teachers here, and about
          other schools in the card above.
        */}
        There is no ranking of teachers here, and that is deliberate — a teacher
        given the weaker set scores lower however well they teach, so a table
        built on their students&rsquo; results measures the timetable.{" "}
        <Link href="/institute/teachers">Teachers</Link> shows what each of them has set
        and what is waiting on them.
      </p>
    </>
  );
}
