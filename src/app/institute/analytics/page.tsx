import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { batches, MIN_MEASURED } from "@/core/institute/batches";
import {
  instituteAnalytics,
  MIN_COMPARABLE_CLASSES,
  STUDENT_THRESHOLD,
  type ConceptSpreadRow,
  type Insight,
} from "@/core/institute/analytics";
import { EmptyState, PageHeader } from "@/ui";

export const metadata: Metadata = { title: "Analytics" };

export const dynamic = "force-dynamic";

/**
 * The institute's analytics.
 *
 * ---------------------------------------------------------------------------
 * Exceptions before counts, again
 * ---------------------------------------------------------------------------
 * The page opens with what to do and why, not with a table. An owner who wants
 * the table scrolls to it; an owner who opens this on a Monday morning between
 * two other things gets the two ideas that are below the line in more than one
 * room, and a link to where each is fixed.
 *
 * ---------------------------------------------------------------------------
 * There is no ranking of teachers on this page and no single institute score
 * ---------------------------------------------------------------------------
 * Both refusals are written on the page itself, at the bottom, because this is
 * the surface where somebody asks for them. See the long note at the top of
 * `core/institute/analytics.ts` for why.
 *
 * The plan gate is on the layout — `can(organizationId, "admin_console")` —
 * which is where every surface in this product is gated. Nineteen pages under
 * /t once checked only for a session and any signed-in user could read the
 * teacher workspace; a surface is gated by its layout, not by each page.
 */
function band(estimate: number): string {
  if (estimate < 0.4) return "CRITICAL";
  if (estimate < 0.6) return "FRAGILE";
  if (estimate < 0.8) return "DEVELOPING";
  return "SECURE";
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

const VERDICT_LABEL: Record<ConceptSpreadRow["verdict"], string> = {
  systemic: "Weak in more than one class",
  localised: "Weak in one class",
  steady: "Steady",
  "not-comparable": "Not enough classes to compare",
};

const SEVERITY_LABEL: Record<Insight["severity"], string> = {
  high: "Worth an hour today",
  medium: "Worth a look this week",
};

export default async function InstituteAnalyticsPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const organizationId = session.actor.organizationId;
  const [rows, analytics] = await Promise.all([
    batches(organizationId),
    instituteAnalytics(organizationId),
  ]);

  const { insights, concepts, improvement, spread } = analytics;
  const high = insights.filter((row) => row.severity === "high");
  const medium = insights.filter((row) => row.severity === "medium");

  // Only the concepts with a verdict an owner can act on get a card. The rest
  // are in the grid below, which is the evidence behind the cards rather than a
  // second opinion about it.
  const actionable = concepts.filter(
    (row) => row.verdict === "systemic" || row.verdict === "localised",
  );

  // Concepts at least one batch has a real number on. The denominator behind
  // "nothing is weak" — without it that sentence is indistinguishable from
  // "nothing has been marked".
  const judged = concepts.filter((row) => row.verdict !== "not-comparable").length;

  // Columns are sorted and stay sorted. A grid whose columns reshuffle between
  // two page loads is a grid nobody can compare — the same rule the teacher's
  // heatmap follows.
  const columns = [...rows].sort((a, b) => a.className.localeCompare(b.className));

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Every batch side by side, the ideas that are weak in more than one of them, and what has actually improved against a baseline written down before the teaching."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No classes yet"
          body="This page compares batches with each other. It needs at least two classes with marked work behind them before it can say anything worth reading."
          actions={
            <Link href="/teacher/classes/new" className="ui-button" data-variant="primary">
              <span>Create a class</span>
            </Link>
          }
        />
      ) : (
        <>
          {/* ------------------------------------------------ What to do -- */}
          <section>
            <h2 className="ui-section-heading">What to do first</h2>
            {insights.length === 0 ? (
              <p className="ui-exception-none">
                Nothing here needs an owner. No idea is below the line in more
                than one class, every batch with students has enough marked work
                to be compared, and nothing has been tried and left unmeasured.
              </p>
            ) : (
              <div className="ui-exceptions">
                {[high, medium].map((group, index) =>
                  group.length === 0 ? null : (
                    <div key={index}>
                      <h3 className="ui-finding-group">
                        {SEVERITY_LABEL[group[0]!.severity]}
                      </h3>
                      <ul className="ui-finding-list">
                        {group.map((row, position) => (
                          <li
                            key={`${row.kind}-${position}`}
                            className="ui-finding"
                            data-severity={row.severity}
                          >
                            <p className="ui-finding-subject">{row.subject}</p>
                            {/* The finding, with the denominators it was
                                computed over. Never a bare percentage. */}
                            <p className="ui-finding-message">{row.message}</p>
                            {/* And what to do about it. An insight that ends in
                                a number ends nowhere. */}
                            <p className="ui-finding-action">{row.action}</p>
                            <Link
                              href={row.href}
                              className="ui-button ui-finding-go"
                              data-variant="secondary"
                              data-size="sm"
                            >
                              <span>Go there</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ),
                )}
              </div>
            )}
          </section>

          {/* ------------------------------ Weak in more than one class -- */}
          <section className="ui-spread-section">
            <h2 className="ui-section-heading">
              The same idea, across every batch
            </h2>
            <p className="ui-hint">
              Weak in more than one room usually means the material or the order
              it is taught in; weak in one room usually means that room. They
              need different answers, and an owner is the only person who can
              see both. A class with fewer than {MIN_MEASURED} measured students
              gets no number here — it is not weak and it is not fine, it is
              unknown.
            </p>

            {actionable.length === 0 ? (
              <p className="ui-spread-none">
                {/*
                  Three different sentences, because "nothing is weak" and
                  "nothing can be judged yet" are opposite findings and only one
                  of them is good news. Collapsing them into one line would tell
                  an owner their batches are fine when what is true is that
                  nobody has marked enough work to know.
                */}
                {analytics.conceptsWithEvidence === 0
                  ? "No concept has evidence behind it yet. This section fills in once papers have been sat and marked."
                  : judged === 0
                    ? `No batch has ${MIN_MEASURED} measured students on any single concept yet, so nothing here can be compared. That is not the same as nothing being wrong — it is that there is not enough marked work to say either way.`
                    : `Nothing is below ${pct(STUDENT_THRESHOLD)} in any batch that has enough measured students to say so. ${judged} of ${analytics.conceptsWithEvidence} concepts with evidence could be judged at all; the grid below lists them.`}
              </p>
            ) : (
              <ul className="ui-spread-list">
                {actionable.slice(0, 8).map((concept) => (
                  <li key={concept.conceptId} className="ui-spread-card">
                    <div className="ui-spread-head">
                      <h3 className="ui-spread-name">{concept.conceptName}</h3>
                      <span
                        className="ui-verdict"
                        data-verdict={concept.verdict}
                      >
                        {VERDICT_LABEL[concept.verdict]}
                      </span>
                    </div>

                    <p className="ui-spread-sentence">{concept.sentence}</p>

                    {/* Every class with evidence, weakest first, each carrying
                        the students it was computed over. The number is the
                        chip, never a colour on its own: this has to survive a
                        colourblind reader and a printout. */}
                    <ul className="ui-cohort-chips">
                      {concept.classes.map((cell) => (
                        <li key={cell.classId} className="ui-cohort-chip">
                          <span className="ui-cohort-chip-name">
                            {cell.className}
                          </span>
                          {cell.meanEstimate === null ? (
                            <span className="ui-refused">
                              not enough measured ({cell.measured} of{" "}
                              {cell.enrolled})
                            </span>
                          ) : (
                            <span data-band={cell.band}>
                              {pct(cell.meanEstimate)} over {cell.measured} of{" "}
                              {cell.enrolled}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>

                    <p className="ui-spread-action">{concept.action}</p>
                    <Link
                      href={concept.href}
                      className="ui-button ui-finding-go"
                      data-variant="secondary"
                      data-size="sm"
                    >
                      <span>Open the gaps</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ------------------------------------------ Batches side by side */}
          <section className="ui-spread-section">
            <h2 className="ui-section-heading">Batches side by side</h2>
            <p className="ui-hint">{spread.sentence}</p>

            <div
              // A region that scrolls but has no tab stop cannot be scrolled by
              // a keyboard at all. axe reports it only once the content actually
              // overflows, which is why this fired at 390px and not at 1280.
              tabIndex={0}
              role="region"
              aria-label="Batches side by side, scrollable"
              className="ui-table-scroll"
            >
              <table className="ui-table">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th>Subject</th>
                    <th className="tabular">Students</th>
                    <th className="tabular">Measured</th>
                    <th className="tabular">Mastery</th>
                    <th className="tabular">Open gaps</th>
                    <th className="tabular">Unmarked</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.classId}>
                      <td>
                        <Link href={`/teacher/analytics/${row.classId}`}>
                          {row.className}
                        </Link>
                      </td>
                      <td>{row.subjectName}</td>
                      <td className="tabular">{row.students}</td>
                      {/*
                        The denominator sits beside the number, always. "10-A is
                        at 71%" is the sentence an owner wants and is almost
                        always wrong — 71% over four measured students of thirty
                        describes nothing at all.
                      */}
                      <td className="tabular">
                        {row.measured} of {row.students}
                      </td>
                      <td className="tabular">
                        {row.meanEstimate === null ? (
                          <span
                            className="ui-refused"
                            title={`Fewer than ${MIN_MEASURED} students have enough evidence`}
                          >
                            not enough measured
                          </span>
                        ) : (
                          <span data-band={band(row.meanEstimate)}>
                            {pct(row.meanEstimate)}
                          </span>
                        )}
                      </td>
                      <td className="tabular">{row.openGaps}</td>
                      <td className="tabular">{row.unmarkedPapers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* --------------------------------------- The grid behind it -- */}
          {concepts.length > 0 && (
            <section className="ui-spread-section">
              <h2 className="ui-section-heading">Every concept, class by class</h2>
              <p className="ui-hint">
                The evidence behind the cards above, in full. An empty cell is a
                class with too little marked work on that concept to say
                anything — not a zero.
              </p>

              <div
                // Same rule as above. This is the wider of the two — one column
                // per class — so it is the one that overflows first.
                tabIndex={0}
                role="region"
                aria-label="Every concept, class by class, scrollable"
                className="ui-table-scroll"
              >
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th>Concept</th>
                      {columns.map((column) => (
                        <th key={column.classId} className="tabular">
                          {column.className}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {concepts.slice(0, 20).map((concept) => (
                      <tr key={concept.conceptId}>
                        <td>{concept.conceptName}</td>
                        {columns.map((column) => {
                          const cell = concept.classes.find(
                            (each) => each.classId === column.classId,
                          );
                          return (
                            <td key={column.classId} className="tabular">
                              {!cell || cell.meanEstimate === null ? (
                                <span
                                  className="ui-refused"
                                  title={
                                    cell
                                      ? `${cell.measured} of ${cell.enrolled} measured`
                                      : "no evidence on this concept yet"
                                  }
                                >
                                  &mdash;
                                </span>
                              ) : (
                                <span data-band={cell.band}>
                                  {pct(cell.meanEstimate)}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ------------------------------------- What actually improved -- */}
          <section className="ui-spread-section">
            <h2 className="ui-section-heading">What actually improved</h2>
            <p className="ui-hint">
              Every figure here is measured against a baseline stamped when the
              work started and never touched since. Nothing on this page
              compares mastery against whatever it happens to be today — that
              number always flatters whoever is reporting it, and an improvement
              claim nobody can check is worse than no claim.
            </p>

            <p
              className="ui-claim"
              data-claimed={improvement.claim.claimed || undefined}
            >
              {improvement.claim.sentence}
            </p>

            {improvement.measured.length > 0 && (
              <ul className="ui-claim-list">
                {improvement.measured.map((row) => (
                  <li
                    key={row.interventionId}
                    className="ui-claim-row"
                    data-reached={row.reachedTarget || undefined}
                  >
                    <span className="ui-claim-verdict">
                      {row.reachedTarget ? "Reached its target" : "Fell short"}
                    </span>
                    <span className="ui-claim-sentence">{row.sentence}</span>
                    <Link
                      href={row.href}
                      className="ui-button ui-finding-go"
                      data-variant="ghost"
                      data-size="sm"
                    >
                      <span>The gap</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ------------------------------------------- The two refusals -- */}
          <p className="ui-hint ui-spread-note">
            {/*
              Said out loud on the page where the request arrives. Both refusals
              are permanent and both are argued at length in
              core/institute/analytics.ts.
            */}
            There is no single score for the institute here, and there never
            will be: averaging across concepts produces a number that moves when
            the syllabus moves, and it is exactly the number that would be
            compared between branches and then between teachers. Nor is there
            any ranking of teachers — a teacher handed the weaker set scores
            lower however well they teach, so a table built on their students&rsquo;
            results measures the timetable. A cohort needs at least{" "}
            {MIN_MEASURED} measured students before it has a figure at all, and
            comparing needs at least {MIN_COMPARABLE_CLASSES} cohorts that have
            one. <Link href="/institute/teachers">Teachers</Link> shows what each of them
            has set and what is waiting on them.
          </p>
        </>
      )}
    </>
  );
}
