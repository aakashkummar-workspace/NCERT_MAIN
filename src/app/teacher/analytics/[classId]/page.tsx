import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { classOverview, displayPercent, MIN_MEASURED } from "@/core/analytics/class";
import { insightIncluded } from "@/core/analytics/insight";
import { AppShell } from "@/ui/AppShell";
import { Alert, Card, EmptyState, PageHeader, Stack } from "@/ui";
import { BAND_LABEL, type MasteryBand } from "@/ui/Mastery";
import { InsightPanel } from "./InsightPanel";

export const metadata: Metadata = { title: "Class analytics" };

export const dynamic = "force-dynamic";

/** Ordered weakest first, so a legend reads the way the colours do. */
const LEGEND: MasteryBand[] = [
  "CRITICAL",
  "FRAGILE",
  "DEVELOPING",
  "SECURE",
  "INSUFFICIENT",
];

export default async function ClassAnalyticsPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { classId } = await params;
  if (!z.uuid().safeParse(classId).success) notFound();
  const [overview, included] = await Promise.all([
    classOverview(session.actor.organizationId, classId),
    insightIncluded(session.actor.organizationId),
  ]);
  if (!overview) notFound();

  const attention = overview.concepts.filter((concept) => concept.needsAttention);

  return (
    <AppShell
      currentPath="/teacher/analytics"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/teacher/analytics">Analytics</Link>}
        title={overview.className}
        description={`${overview.subjectName} · ${overview.students} ${
          overview.students === 1 ? "student" : "students"
        }`}
        actions={
          <Link
            href={`/teacher/analytics/${classId}/gaps`}
            className="ui-button"
            data-variant="primary"
          >
            <span>Learning gaps</span>
          </Link>
        }
      />

      {overview.concepts.length === 0 ? (
        <EmptyState
          title="Nothing measured yet"
          body="This fills in once a paper has been sat and marked. Mastery is measured per concept, and only questions mapped to a concept can produce it."
        />
      ) : (
        <Stack>
          <InsightPanel classId={classId} included={included} />

          {overview.unmeasuredStudents > 0 && (
            // Named rather than left as a gap in the grid. A teacher reading a
            // column of good numbers should know how many students are not in
            // it.
            <Alert
              tone="info"
              title={`${overview.unmeasuredStudents} of ${overview.students} students have nothing measured yet`}
            >
              They have not had a paper marked, so every cell for them reads
              &ldquo;{BAND_LABEL.INSUFFICIENT.toLowerCase()}&rdquo;. Nothing below is
              computed from them.
            </Alert>
          )}

          {attention.length > 0 && (
            <Card
              title="Worth a lesson"
              description="More than half the measured students are struggling with these."
            >
              <ul className="ui-attention">
                {attention.map((concept) => (
                  <li key={concept.conceptId}>
                    <span>
                      <strong>{concept.conceptName}</strong>
                      {concept.chapters.length > 0 && (
                        <span className="ui-analytics-where">
                          {" "}
                          — {concept.chapters.join(", ")}
                        </span>
                      )}
                      <br />
                      {concept.struggling} of {concept.measured} measured students.
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card
            title="By concept"
            description="Each bar is the whole class: how many students sit in each band."
          >
            <ul className="ui-concept-rows">
              {overview.concepts.map((concept) => (
                <li key={concept.conceptId} className="ui-concept-row">
                  <div className="ui-concept-head">
                    <span className="ui-concept-name">{concept.conceptName}</span>
                    <span className="ui-concept-mean tabular">
                      {/*
                        Null below the threshold, and it says why rather than
                        showing an em dash a teacher has to interpret. Averaging
                        two measured students and calling it the class is
                        arithmetically correct and a false claim.
                      */}
                      {concept.meanEstimate === null
                        ? `${concept.measured} of ${concept.total} measured`
                        : `${displayPercent(concept.meanEstimate)}% across ${concept.measured}`}
                    </span>
                  </div>

                  {/* Stacked, with a 2px gap between segments so adjacent
                      bands stay distinguishable at any width. */}
                  <div className="ui-band-bar" role="img" aria-label={bandSummary(concept.counts, concept.total)}>
                    {LEGEND.map((band) =>
                      concept.counts[band] > 0 ? (
                        <span
                          key={band}
                          className="ui-band-segment"
                          data-band={band}
                          style={{
                            width: `${(concept.counts[band] / concept.total) * 100}%`,
                          }}
                        />
                      ) : null,
                    )}
                  </div>

                  <p className="ui-concept-counts">
                    {LEGEND.filter((band) => concept.counts[band] > 0).map((band) => (
                      <span key={band} className="ui-concept-count">
                        <span className="ui-band-dot" data-band={band} aria-hidden="true" />
                        {concept.counts[band]} {BAND_LABEL[band].toLowerCase()}
                      </span>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          </Card>

          <Card
            title="Student by concept"
            description="The number in each cell is that student's estimate. A dash means we have not seen enough of their work to say."
          >
            <ul className="ui-legend">
              {LEGEND.map((band) => (
                <li key={band}>
                  <span className="ui-band-dot" data-band={band} aria-hidden="true" />
                  {BAND_LABEL[band]}
                </li>
              ))}
            </ul>

            <div
          className="ui-heatmap-scroll"
          // Focusable and named: it scrolls sideways, and without a tab stop
          // a keyboard user cannot reach the columns that are off-screen at
          // all. axe calls this scrollable-region-focusable, and it fires
          // only once the content actually overflows — which on a real class
          // it always will.
          tabIndex={0}
          role="region"
          aria-label="Mastery by student and concept, scrollable"
        >
              <table className="ui-heatmap">
                <caption className="sr-only">
                  Mastery estimate per student and concept, as a percentage.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Student</th>
                    {overview.concepts.map((concept) => (
                      <th key={concept.conceptId} scope="col">
                        {concept.conceptName}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {overview.rows.map((row) => (
                    <tr key={row.studentUserId}>
                      <th scope="row">
                        <Link href={`/teacher/students/${row.studentUserId}`}>
                          {row.fullName}
                        </Link>
                      </th>
                      {row.cells.map((cell) => (
                        <td key={cell.conceptId}>
                          {/*
                            The number is the redundant encoding: colour is
                            never the only thing carrying the value, so the grid
                            survives a colourblind reader, a bad screen and a
                            printout.
                          */}
                          <span className="ui-heat-cell" data-band={cell.band}>
                            {/*
                              Floored, not rounded: 0.595 is "needs practice",
                              and a cell reading 60 in that colour contradicts
                              the legend on the band line itself.
                            */}
                            {cell.estimate === null
                              ? "–"
                              : `${displayPercent(cell.estimate)}`}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="ui-hint" style={{ marginTop: 14 }}>
              A concept needs {MIN_MEASURED} measured students before a class
              figure is reported at all.
            </p>
          </Card>
        </Stack>
      )}
    </AppShell>
  );
}

function bandSummary(
  counts: Record<MasteryBand, number>,
  total: number,
): string {
  return LEGEND.filter((band) => counts[band] > 0)
    .map((band) => `${counts[band]} of ${total} ${BAND_LABEL[band].toLowerCase()}`)
    .join(", ");
}
