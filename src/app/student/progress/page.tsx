import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { studentMastery } from "@/core/mastery/read";
import { MIN_EVIDENCE } from "@/core/mastery/estimate";
import { conceptsWithSeparateReadings } from "@/core/readiness";
import { StudentShell } from "@/ui/StudentShell";
import { EmptyState, PageHeader } from "@/ui";
import { MasteryCard } from "@/ui/Mastery";

export const metadata: Metadata = { title: "My progress" };

export const dynamic = "force-dynamic";

export default async function ProgressPage() {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const [mastery, separateReadings] = await Promise.all([
    studentMastery(session.actor.organizationId, session.actor.userId),
    conceptsWithSeparateReadings({
      organizationId: session.actor.organizationId,
      userId: session.actor.userId,
    }),
  ]);

  // An arrow only where two sittings are being compared. After one paper the
  // stored trend can compare that paper with itself — objective answers first,
  // the marked written one after — and "holding steady" off a single sitting
  // is a claim about progress nobody has made yet.
  const trendOf = (item: (typeof mastery)[number]) =>
    separateReadings.has(item.conceptId) ? item.trend : "UNKNOWN";

  // Weakest first — that ordering comes from core/, not from this page. A
  // student opening this is asking "where do I start", and the answer is the
  // first card.
  const known = mastery.filter((item) => item.band !== "INSUFFICIENT");
  const unknown = mastery.filter((item) => item.band === "INSUFFICIENT");

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title="My progress"
        description={
          known.length > 0
            ? "What your answers so far say about each idea. The ones that need work are first."
            : "This fills in as you take tests."
        }
        actions={
          <>
            {/*
              This page answers "how am I doing on each idea". The question
              underneath it — "is that enough of the syllabus to mean
              anything" — is a different one, and it is the one a student asks
              before an exam. It gets its own page rather than a strip here,
              because the honest answer is usually a refusal and a refusal
              needs room to explain itself.
            */}
            <Link
              href="/student/readiness"
              className="ui-button"
              data-variant="secondary"
            >
              <span>Exam readiness</span>
            </Link>
            <Link href="/student" className="ui-button" data-variant="secondary">
              <span>Back to my tests</span>
            </Link>
          </>
        }
      />

      {mastery.length === 0 ? (
        <EmptyState
          title="Nothing measured yet"
          body="Once you have taken a test and it has been marked, this page shows what your answers say about each idea — and which one to work on next."
        />
      ) : (
        <>
          {known.length > 0 && (
            <div className="ui-mastery-list">
              {known.map((item) => (
                <MasteryCard
                  key={item.conceptId}
                  title={item.conceptName}
                  where={item.chapters.join(" · ")}
                  band={item.band}
                  estimate={item.estimate}
                  evidenceCount={item.evidenceCount}
                  trend={trendOf(item)}
                />
              ))}
            </div>
          )}

          {unknown.length > 0 && (
            <>
              <h2 className="ui-section-heading">Not measured yet</h2>
              {/*
                Said plainly rather than shown as a bar at zero. "We have not
                seen enough" and "you scored nothing" are opposite statements,
                and only one of them is about the student.
              */}
              <p className="ui-review-note">
                A few more answers on each of these and they will fill in.
              </p>
              <div className="ui-mastery-list">
                {unknown.map((item) => (
                  <MasteryCard
                    key={item.conceptId}
                    title={item.conceptName}
                    where={item.chapters.join(" · ")}
                    band={item.band}
                    estimate={item.estimate}
                    evidenceCount={item.evidenceCount}
                    needed={MIN_EVIDENCE}
                    trend={trendOf(item)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </StudentShell>
  );
}
