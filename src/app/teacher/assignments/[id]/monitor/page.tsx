import Link from "next/link";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { liveView, type SittingState } from "@/core/assignments/monitor";
import { AppShell } from "@/ui/AppShell";
import { Alert, Badge, PageHeader, StatCard, type Tone } from "@/ui";
import { Refresher } from "./Refresher";

export const metadata: Metadata = { title: "Live" };

// Nothing here may be cached: the whole page is "as of now".
export const dynamic = "force-dynamic";

const STATE: Record<SittingState, { label: string; tone: Tone }> = {
  IN_PROGRESS: { label: "Writing", tone: "primary" },
  NOT_STARTED: { label: "Not started", tone: "warning" },
  SUBMITTED: { label: "Handed in", tone: "success" },
  AUTO_SUBMITTED: { label: "Time ran out", tone: "neutral" },
};

const CLOCK = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

/** "12 min left", or "over" — minutes, because an exam clock moves in minutes. */
function left(ms: number | null): string {
  if (ms === null) return "—";
  if (ms <= 0) return "over";
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "under a minute" : `${minutes} min left`;
}

/**
 * Who is sitting this paper, right now.
 *
 * IMPLEMENTATION_PLAN.md §7.1. The refusals are in `core/assignments/monitor.ts`:
 * no score while a paper is being written, no proctoring signals, and every
 * state derived from stamps rather than stored.
 */
export default async function MonitorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");
  if (session.actor.role === "STUDENT") redirect("/student");
  if (session.actor.role === "PARENT") redirect("/parent");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const view = await liveView(session.actor.organizationId, id);
  if (!view) notFound();

  const open = view.status === "OPEN";

  return (
    <AppShell
      fullName={session.fullName}
      organizationName={session.organizationName}
      currentPath="/teacher/assessments"
      breadcrumbs={[
        { label: "Assignments", href: "/teacher/assessments" },
        { label: view.assessmentTitle, href: `/teacher/assignments/${id}` },
        { label: "Live" },
      ]}
    >
      <PageHeader
        title="Live"
        description={`${view.assessmentTitle} · ${view.className} · ${view.durationMinutes} minutes`}
      />

      {!open && (
        // Said plainly rather than shown as an empty room. A closed paper's
        // page is a record of what happened, not a live view.
        <Alert tone="info" title="This paper is not open">
          {view.status === "SCHEDULED"
            ? `It opens at ${CLOCK.format(view.opensAt)}. Nobody can start before then.`
            : `The window closed at ${CLOCK.format(view.closesAt)}. What follows is how it finished.`}
        </Alert>
      )}

      <Refresher live={open} />

      <div className="ui-grid" data-cols="4">
        <StatCard label="Writing now" value={String(view.counts.inProgress)} />
        <StatCard
          label="Not started"
          value={String(view.counts.notStarted)}
          context={open ? "Of the students this was set for" : "They never sat it"}
        />
        <StatCard label="Handed in" value={String(view.counts.submitted)} />
        <StatCard
          label="Time ran out"
          value={String(view.counts.autoSubmitted)}
          context="Submitted by the clock"
        />
      </div>

      <section className="ui-live" aria-label="Students">
        <h2 className="ui-section-heading">
          {view.counts.expected} students · as of {CLOCK.format(view.readAt)}
        </h2>

        <ul className="ui-live-list">
          {view.sittings.map((sitting) => {
            const state = STATE[sitting.state];
            return (
              <li key={sitting.studentUserId} className="ui-live-row" data-state={sitting.state}>
                <span className="ui-live-name">{sitting.fullName}</span>
                <Badge tone={state.tone}>{state.label}</Badge>

                {/*
                  Answered N of M, never a score. During a paper the only
                  useful reading is how far through they are — and a mark
                  would be a number that moves every minute about one child.
                */}
                <span className="ui-live-progress tabular">
                  {sitting.state === "NOT_STARTED"
                    ? "—"
                    : `${sitting.answered} of ${sitting.questionCount} answered`}
                </span>

                <span className="ui-live-clock tabular">
                  {sitting.state === "IN_PROGRESS"
                    ? left(sitting.timeLeftMs)
                    : sitting.submittedAt
                      ? CLOCK.format(sitting.submittedAt)
                      : ""}
                </span>
              </li>
            );
          })}
        </ul>

        {view.counts.expected === 0 && (
          <p className="ui-hint">
            Nobody is enrolled in this class yet, so there is nobody to sit it.
          </p>
        )}
      </section>

      <p className="ui-hint" style={{ marginTop: 16 }}>
        Marks are not shown while a paper is being written: a score over a
        half-finished paper changes every minute and says nothing.{" "}
        <Link href={`/teacher/assignments/${id}/results`}>Results</Link> are here
        once it closes.
      </p>
    </AppShell>
  );
}
