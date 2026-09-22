import { z } from "zod";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { studentProfile } from "@/core/analytics/student";
import { getAccommodations } from "@/core/roster/accommodations";
import { AccommodationsForm } from "./AccommodationsForm";
import { getApaar } from "@/core/roster/apaar";
import { ApaarForm } from "./ApaarForm";
import { HolisticForm } from "./HolisticForm";
import { DOMAINS, LEVELS, recentHolistic } from "@/core/reports/holistic";
import { MIN_EVIDENCE } from "@/core/mastery/estimate";
import { AppShell } from "@/ui/AppShell";
import { Badge, Card, EmptyState, PageHeader, Stack } from "@/ui";
import { MasteryCard } from "@/ui/Mastery";
import { ParentLinks } from "@/ui/ParentLinks";

export const metadata: Metadata = { title: "Student" };

export const dynamic = "force-dynamic";

export default async function StudentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  // A malformed id is a page that does not exist, not a database error.
  if (!z.uuid().safeParse(id).success) notFound();
  const [profile, accommodations, holistic, apaarId] = await Promise.all([
    studentProfile(session.actor.organizationId, id),
    getAccommodations(session.actor.organizationId, id),
    recentHolistic(session.actor.organizationId, id),
    getApaar(session.actor.organizationId, id),
  ]);
  if (!profile) notFound();

  return (
    <AppShell
      currentPath="/teacher/analytics"
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/teacher/analytics">Analytics</Link>}
        title={profile.fullName}
        description={
          profile.classNames.length > 0
            ? profile.classNames.join(" · ")
            : "Not enrolled in any class."
        }
        actions={
          <Link
            href={`/teacher/students/${id}/meeting`}
            className="ui-button"
            data-variant="secondary"
            data-size="md"
          >
            <span>Meeting brief</span>
          </Link>
        }
      />

      <div className="ui-class-layout">
        <Stack>
          <Card
            title="What they know"
            description={
              profile.measuredConcepts > 0
                ? "Drawn from every marked answer, weighted by how hard the question was and how long ago."
                : "Nothing has enough evidence behind it yet."
            }
          >
            {profile.mastery.length === 0 ? (
              <EmptyState
                title="Nothing measured yet"
                body="Once a paper of theirs has been marked, this shows what their answers say about each concept."
              />
            ) : (
              <div className="ui-mastery-list">
                {profile.mastery.map((item) => (
                  <MasteryCard
                    key={item.conceptId}
                    title={item.conceptName}
                    where={item.chapters.join(" · ")}
                    band={item.band}
                    estimate={item.estimate}
                    evidenceCount={item.evidenceCount}
                    needed={MIN_EVIDENCE}
                    trend={item.trend}
                  />
                ))}
              </div>
            )}
          </Card>
        </Stack>

        <Stack>
          <Card
            title="Papers sat"
            description="A score is one event. Mastery is what we believe across them — the two are next to each other so neither has to stand alone."
          >
            {profile.sittings.length === 0 ? (
              <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>
                They have not sat anything yet.
              </p>
            ) : (
              <ul className="ui-sitting-list">
                {profile.sittings.map((sitting) => (
                  <li key={sitting.attemptId}>
                    <span className="ui-sitting-title">{sitting.title}</span>
                    <span className="ui-sitting-when">
                      {sitting.submittedAt
                        ? new Intl.DateTimeFormat("en-IN", {
                            dateStyle: "medium",
                            timeZone: "Asia/Kolkata",
                          }).format(sitting.submittedAt)
                        : "Not submitted"}
                    </span>
                    {sitting.pendingMarks > 0 && (
                      <Badge tone="warning">
                        {sitting.pendingMarks}{" "}
                        {sitting.pendingMarks === 1 ? "mark" : "marks"} still to award
                      </Badge>
                    )}
                    <span className="ui-row-score tabular">
                      {/*
                        A score with marks outstanding is partial, and saying so
                        is cheaper than a teacher comparing it against a
                        finished one without noticing.
                      */}
                      {sitting.rawScore === null
                        ? "—"
                        : `${sitting.rawScore} / ${sitting.maxScore}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {/* The only place a parent is invited, seen or removed. Without it the
              consent page's promise — the centre can take this access away at
              any time — could not be kept from the product. */}
          <ParentLinks studentId={id} studentName={profile.fullName} />
          <Card
            title="Exam accommodations"
            description="For a student entitled to them — CBSE's extra time and reader. Seen by staff only."
          >
            <AccommodationsForm studentId={id} initial={accommodations} />
          </Card>
          <Card
            title="APAAR ID"
            description="The national student ID. Used only to match marks exports to the registry — never to sign in."
          >
            <ApaarForm studentId={id} initial={apaarId} />
          </Card>
          <Card
            title="Beyond marks"
            description="What you see in class that a test cannot. Words, not scores — printed on the next term report as written."
          >
            <HolisticForm
              studentId={id}
              domains={DOMAINS.map((domain) => ({ key: domain.key, label: domain.label }))}
              levels={[...LEVELS]}
              latest={Object.fromEntries(holistic.map((line) => [line.domain, { level: line.level, note: line.note }]))}
            />
          </Card>
        </Stack>
      </div>
    </AppShell>
  );
}
