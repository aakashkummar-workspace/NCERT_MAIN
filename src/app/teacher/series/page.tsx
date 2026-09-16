import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listSeries, type SeriesStatus } from "@/core/series";
import { currentAcademicYear } from "@/core/curriculum";
import { AppShell } from "@/ui/AppShell";
import { Badge, EmptyState, PageHeader, Stack } from "@/ui";
import { formatDate } from "@/i18n/format";
import { NewSeries } from "./NewSeries";

export const metadata: Metadata = { title: "Exam series" };

export const dynamic = "force-dynamic";

/**
 * Every state is derived from the papers' own windows and the clock. There is
 * no status column, so this list cannot disagree with the papers it describes.
 */
const STATUS_LABEL: Record<SeriesStatus, string> = {
  EMPTY: "No papers yet",
  UPCOMING: "Coming up",
  RUNNING: "Under way",
  FINISHED: "Finished",
  WITHDRAWN: "Withdrawn",
};

const STATUS_TONE: Record<SeriesStatus, "neutral" | "primary" | "success" | "warning"> = {
  EMPTY: "neutral",
  UPCOMING: "primary",
  RUNNING: "warning",
  FINISHED: "success",
  WITHDRAWN: "neutral",
};

export default async function SeriesPage() {
  const session = await getSession();
  if (!session) redirect("/signin");
  if (session.actor.role === "STUDENT") redirect("/student");
  if (session.actor.role === "PARENT") redirect("/parent");

  const series = await listSeries(session.actor.organizationId);

  return (
    <AppShell
      currentPath="/teacher/series"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title="Exam series"
        description={
          series.length > 0
            ? "A half-yearly is six papers that belong together. Naming the event groups them on a report — and nothing else changes: each paper keeps its own window, marking and release."
            : undefined
        }
        actions={<NewSeries academicYear={currentAcademicYear()} />}
      />

      {series.length === 0 ? (
        <EmptyState
          icon="◲"
          title="No series yet"
          body="A half-yearly is six assignments with no relationship between them: you set each one, and a parent sees six unrelated results. Naming a series ties them together on the report. It holds no marks and no total of its own — the papers keep their own windows, marking and release, and a series can be named after the week it happened in."
          actions={
            <NewSeries
              academicYear={currentAcademicYear()}
              label="Name your first series"
            />
          }
        />
      ) : (
        <Stack>
          <ul className="ui-series-list">
            {series.map((row) => (
              <li key={row.id}>
                <Link href={`/teacher/series/${row.id}`}>
                  <span className="ui-series-title">{row.name}</span>
                  <span className="ui-series-meta">
                    <Badge tone={STATUS_TONE[row.status]}>
                      {STATUS_LABEL[row.status]}
                    </Badge>
                    <span className="tabular">{row.academicYear}</span>
                    <span className="tabular">
                      {row.papers} {row.papers === 1 ? "paper" : "papers"}
                    </span>
                    {/* From the papers' windows, not from a stored schedule. */}
                    {row.from && row.to && (
                      <span className="tabular">
                        {formatDate("en-IN", row.from)} – {formatDate("en-IN", row.to)}
                      </span>
                    )}
                  </span>
                  {row.note && <span className="ui-series-note">{row.note}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </Stack>
      )}
    </AppShell>
  );
}
