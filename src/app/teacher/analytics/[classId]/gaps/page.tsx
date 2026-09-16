import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { z } from "zod";
import { getSession } from "@/core/identity/context";
import { classOverview } from "@/core/analytics/class";
import { classGaps, type Gap, type Severity } from "@/core/gaps/read";
import { listInterventions, type InterventionRow } from "@/core/gaps/interventions";
import { AppShell } from "@/ui/AppShell";
import { Badge, EmptyState, PageHeader, type Tone } from "@/ui";
import { AcknowledgeButton } from "./AcknowledgeButton";
import { InterventionPanel } from "./InterventionPanel";

export const metadata: Metadata = { title: "Learning gaps" };

export const dynamic = "force-dynamic";

const SEVERITY_TONE: Record<Severity, Tone> = {
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  DETECTED: "New",
  ACKNOWLEDGED: "Seen",
  INTERVENING: "Being worked on",
  PERSISTING: "Still there after an intervention",
  RESOLVED: "Closed",
};

/**
 * How long a measured result on a closed gap stays on this page.
 *
 * Long enough that a teacher who measured on Friday still sees the result on
 * Monday; short enough that the page does not become an archive.
 */
const RECENT_MEASUREMENT_DAYS = 30;

const OPEN_STATUSES = new Set(["PLANNED", "ACTIVE"]);

export default async function GapsPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { classId } = await params;
  if (!z.uuid().safeParse(classId).success) notFound();

  const [overview, allGaps, interventions] = await Promise.all([
    classOverview(session.actor.organizationId, classId),
    classGaps(session.actor.organizationId, classId, { includeResolved: true }),
    listInterventions(session.actor.organizationId, classId),
  ]);
  if (!overview) notFound();

  // The latest one per gap. `listInterventions` is newest first, so the first
  // sighting of a gap id is the one that matters — an older measured attempt is
  // history, and the card is about what to do next.
  const latest = new Map<string, InterventionRow>();
  for (const intervention of interventions) {
    if (!latest.has(intervention.gapId)) latest.set(intervention.gapId, intervention);
  }

  const gaps = allGaps.filter((gap) => gap.status !== "RESOLVED");

  // A gap that closed while something was being tried is the SUCCESS case, and
  // it used to vanish from this page together with its "Measure it now" button
  // — so the only interventions anybody could record were the ones that failed.
  // An open intervention on a closed gap stays here until it is measured, and
  // the measured result stays long enough to be read.
  const closedWithWork = closedGapsWithWork(allGaps, latest);
  const toMeasure = closedWithWork.filter((gap) =>
    OPEN_STATUSES.has(latest.get(gap.id)?.status ?? ""),
  ).length;

  return (
    <AppShell
      currentPath="/teacher/analytics"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={
          <Link href={`/teacher/analytics/${classId}`}>{overview.className}</Link>
        }
        title="Learning gaps"
        description="Concepts where enough of this class is below the line, with enough evidence to say so. Ordered by what to do first."
      />

      {gaps.length === 0 && closedWithWork.length === 0 ? (
        <EmptyState
          title="No gaps found"
          body="Either this class is doing well on everything measured, or not enough of them have had a paper marked yet. A gap needs evidence behind it, and the product will not invent one."
        />
      ) : gaps.length === 0 ? (
        <p className="ui-hint">
          No gaps are open in this class right now.
        </p>
      ) : (
        <ul className="ui-gaps">
          {gaps.map((gap) => (
            <GapCard key={gap.id} gap={gap} intervention={latest.get(gap.id) ?? null} />
          ))}
        </ul>
      )}

      {closedWithWork.length > 0 && (
        <section style={{ marginTop: 28 }} aria-labelledby="closed-with-work">
          <h2 id="closed-with-work" className="ui-gap-title" style={{ marginBottom: 6 }}>
            Closed while something was being tried
          </h2>
          <p className="ui-hint" style={{ marginBottom: 14 }}>
            {toMeasure > 0
              ? `The evidence closed ${toMeasure === 1 ? "this gap" : "these gaps"} while an intervention was open. Measure ${toMeasure === 1 ? "it" : "them"} so the result is recorded — a success that is never measured cannot be told apart from luck.`
              : "Measured results on gaps that have since closed."}
          </p>
          <ul className="ui-gaps">
            {closedWithWork.map((gap) => (
              <GapCard key={gap.id} gap={gap} intervention={latest.get(gap.id) ?? null} />
            ))}
          </ul>
        </section>
      )}

      <p className="ui-hint" style={{ marginTop: 18 }}>
        {/*
          Said out loud, because it is the property that makes the list worth
          reading. A gap a teacher could dismiss would turn this page into a
          measure of how tidy they are.
        */}
        A gap closes when the evidence closes it — after the class is measured
        again and comes back above the line. Marking one as seen does not close
        it, and nothing here can.
      </p>
    </AppShell>
  );
}

/** Closed gaps whose latest intervention is unmeasured, or measured recently. */
function closedGapsWithWork(
  gaps: Gap[],
  latest: Map<string, InterventionRow>,
  now = new Date(),
): Gap[] {
  const cutoff = now.getTime() - RECENT_MEASUREMENT_DAYS * 86_400_000;
  return gaps.filter((gap) => {
    if (gap.status !== "RESOLVED") return false;
    const intervention = latest.get(gap.id);
    if (!intervention) return false;
    if (OPEN_STATUSES.has(intervention.status)) return true;
    return (
      intervention.status === "MEASURED" &&
      intervention.measuredAt !== null &&
      intervention.measuredAt.getTime() >= cutoff
    );
  });
}

function GapCard({
  gap,
  intervention,
}: {
  gap: Gap;
  intervention: InterventionRow | null;
}) {
  const closed = gap.status === "RESOLVED";

  return (
    <li className="ui-gap" data-severity={closed ? undefined : gap.severity}>
      <div className="ui-gap-head">
        <div>
          <h2 className="ui-gap-title">{gap.conceptName}</h2>
          {gap.chapters.length > 0 && (
            <p className="ui-gap-where">{gap.chapters.join(" · ")}</p>
          )}
        </div>
        <div className="ui-gap-tags">
          {!closed && <Badge tone={SEVERITY_TONE[gap.severity]}>{gap.severity}</Badge>}
          <Badge
            tone={
              gap.status === "PERSISTING" ? "danger" : closed ? "success" : "neutral"
            }
          >
            {STATUS_LABEL[gap.status] ?? gap.status}
          </Badge>
        </div>
      </div>

      {closed ? (
        <p className="ui-gap-finding">
          The evidence no longer shows this as a gap for the class.
        </p>
      ) : (
        <p className="ui-gap-finding">
          {/*
            The denominator is in the sentence, not implied. "3 of 4
            measured" and "3 of 30 measured" are different findings, and
            a teacher deciding whether to spend a lesson needs the
            second number as much as the first.
          */}
          <strong>
            {gap.affectedStudentCount} of {gap.measuredStudentCount}
          </strong>{" "}
          measured students are below the line, averaging{" "}
          <strong className="tabular">{Math.round(gap.meanEstimate * 100)}%</strong>
          .
        </p>
      )}

      {!closed && gap.rootCauseName && (
        // The most useful line here when it appears. "They cannot do
        // similar triangles" is a symptom; "they cannot do ratio,
        // which it needs" is Monday's lesson.
        <p className="ui-gap-cause">
          They are also weak on <strong>{gap.rootCauseName}</strong>,
          which this builds on. Teaching that first is likely to be
          worth more than reteaching this.
        </p>
      )}

      {gap.status === "PERSISTING" && (
        <p className="ui-gap-cause" data-tone="danger">
          This was worked on, measured, and is still here. Whatever was tried
          has not landed — a different approach is likely to be needed, not
          more of the same.
        </p>
      )}

      {/*
        The loop this whole product exists to close. On the card rather
        than a page of its own, because the decision and the evidence
        for it belong in the same place. A closed gap has nothing new to
        start, but what was already running on it can still be measured.
      */}
      {(!closed || intervention) && (
        <InterventionPanel
          gapId={gap.id}
          intervention={intervention}
          gapClosed={closed}
        />
      )}

      <div className="ui-gap-foot">
        <span className="ui-gap-when">
          First seen{" "}
          {new Intl.DateTimeFormat("en-IN", {
            dateStyle: "medium",
            timeZone: "Asia/Kolkata",
          }).format(gap.detectedAt)}
          {closed && gap.resolvedAt && (
            <>
              {" · closed "}
              {new Intl.DateTimeFormat("en-IN", {
                dateStyle: "medium",
                timeZone: "Asia/Kolkata",
              }).format(gap.resolvedAt)}
            </>
          )}
        </span>
        {gap.status === "DETECTED" && <AcknowledgeButton gapId={gap.id} />}
      </div>
    </li>
  );
}
