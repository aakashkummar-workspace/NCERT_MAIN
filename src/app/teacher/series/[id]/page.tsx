import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getSeries, papersAvailable } from "@/core/series";
import { AppShell } from "@/ui/AppShell";
import { Badge, Card, EmptyState, PageHeader, Stack } from "@/ui";
import { formatDate, formatDateTime } from "@/i18n/format";
import { SeriesPapers } from "./SeriesPapers";
import { WithdrawSeries } from "./WithdrawSeries";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const session = await getSession();
  if (!session) return { title: "Exam series" };
  const { id } = await params;
  const series = await getSeries(session.actor.organizationId, id);
  return { title: series ? series.name : "Exam series" };
}

export const dynamic = "force-dynamic";

const PAPER_TONE = {
  SCHEDULED: "primary",
  OPEN: "warning",
  CLOSED: "success",
  CANCELLED: "neutral",
} as const;

const PAPER_LABEL = {
  SCHEDULED: "Not open yet",
  OPEN: "Open now",
  CLOSED: "Window shut",
  CANCELLED: "Cancelled",
} as const;

export default async function SeriesDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");
  if (session.actor.role === "STUDENT") redirect("/student");
  if (session.actor.role === "PARENT") redirect("/parent");

  const { id } = await params;
  // A malformed id is a 404, not a 500 — Prisma throws on a non-UUID.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [series, available] = await Promise.all([
    getSeries(session.actor.organizationId, id),
    papersAvailable(session.actor.organizationId),
  ]);
  if (!series) notFound();

  const awaiting = series.list.reduce(
    (sum, paper) => sum + paper.awaitingMarking,
    0,
  );

  return (
    <AppShell
      currentPath="/teacher/series"
      fullName={session.fullName}
      organizationName={session.organizationName}
      breadcrumbs={[
        { label: "Exam series", href: "/teacher/series" },
        { label: series.name },
      ]}
      topbarAction={false}
    >
      <PageHeader
        eyebrow={<Link href="/teacher/series">Exam series</Link>}
        title={series.name}
        description={
          series.note ??
          `${series.academicYear} · ${series.papers} ${series.papers === 1 ? "paper" : "papers"}`
        }
        actions={
          series.withdrawn ? undefined : (
            <WithdrawSeries seriesId={series.id} name={series.name} papers={series.papers} />
          )
        }
      />

      {series.withdrawn && (
        <Card>
          <p>
            This series has been withdrawn. Its papers were left exactly as they
            were — same windows, same students, same marks — and are simply no
            longer grouped under this name.
          </p>
        </Card>
      )}

      <Stack>
        {series.list.length === 0 ? (
          <EmptyState
            icon="◲"
            title="No papers in this series yet"
            body="Add papers you have already assigned — including ones a class has already sat. A series is a label over papers, so nothing about them changes when they join it."
          />
        ) : (
          <Card
            title="Papers"
            description={
              /* No total, and the absence is the feature. Six papers out of
                 different totals, some part marked and some unreleased, cannot
                 honestly become one number — and a series is exactly where
                 somebody would print it. */
              "Each paper's own marks, listed. A series carries no total: papers out of different totals, some still being marked, do not average into anything anybody could defend."
            }
          >
            <ul className="ui-series-papers-list">
              {series.list.map((paper) => (
                <li key={paper.assignmentId}>
                  <div className="ui-series-paper-head">
                    <Link href={`/teacher/assignments/${paper.assignmentId}`}>
                      {paper.title}
                    </Link>
                    <Badge tone={PAPER_TONE[paper.status]}>
                      {PAPER_LABEL[paper.status]}
                    </Badge>
                  </div>
                  <p className="ui-series-paper-meta tabular">
                    {paper.className} · {paper.subjectName} ·{" "}
                    {formatDateTime("en-IN", paper.opensAt)} –{" "}
                    {formatDateTime("en-IN", paper.closesAt)}
                  </p>
                  <p className="ui-series-paper-meta tabular">
                    {paper.satCount} of {paper.expected} sat
                    {paper.awaitingMarking > 0
                      ? ` · ${paper.awaitingMarking} still being marked`
                      : ""}
                    {paper.resultsReleased ? " · results released" : ""}
                  </p>
                </li>
              ))}
            </ul>
            {awaiting > 0 && (
              <p className="ui-hint">
                {awaiting === 1
                  ? "One paper in this series is still partly with a teacher."
                  : `${awaiting} papers in this series are still partly with a teacher.`}{" "}
                A mark nobody has read yet is not a zero, so nothing here counts
                it as one.
              </p>
            )}
          </Card>
        )}

        {!series.withdrawn && (
          <Card
            title="Which papers"
            description="Papers already assigned, in no other series. A finished one can still be added — a school often names the event after the week it happened in."
          >
            <SeriesPapers
              seriesId={series.id}
              available={available.map((paper) => ({
                assignmentId: paper.assignmentId,
                title: paper.title,
                className: paper.className,
                status: paper.status,
              }))}
              inSeries={series.list.map((paper) => ({
                assignmentId: paper.assignmentId,
                title: paper.title,
                className: paper.className,
              }))}
            />
          </Card>
        )}

        {series.from && series.to && (
          <p className="ui-hint">
            {/* Derived, never stored: the dates are the papers' own windows,
                so the series cannot claim a schedule its papers contradict. */}
            Runs {formatDate("en-IN", series.from)} to{" "}
            {formatDate("en-IN", series.to)}, taken from the papers&rsquo; own
            windows. There is no separate schedule to keep in step.
          </p>
        )}
      </Stack>
    </AppShell>
  );
}
