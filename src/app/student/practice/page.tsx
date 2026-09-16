import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { recommendations, recentSessions } from "@/core/practice";
import { StudentShell } from "@/ui/StudentShell";
import { EmptyState, PageHeader } from "@/ui";
import { StartPractice } from "./StartPractice";

export const metadata: Metadata = { title: "Practice" };

export const dynamic = "force-dynamic";

export default async function PracticePage({
  searchParams,
}: {
  searchParams: Promise<{ conceptId?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const actor = {
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
  };
  const [suggestions, history] = await Promise.all([
    recommendations(actor),
    recentSessions(actor, 8),
  ]);

  const unfinished = history.filter((row) => row.completedAt === null);

  // Arriving from the study plan, which named one concept. It is hoisted to the
  // top rather than filtered to, and a concept that is no longer a candidate —
  // because they practised it, or because the estimate moved — simply is not
  // there. That is the plan's own rule working: an item leaves when the
  // evidence changes, so following a stale link lands on the ordinary page
  // rather than on an error about something that is no longer true.
  const wanted = (await searchParams).conceptId ?? null;

  // A concept with a set already open is offered once, as "carry on" — not
  // again below as a fresh recommendation. Both routes resume the same session,
  // so two cards for one concept is the page arguing with itself.
  const openConcepts = new Set(unfinished.map((row) => row.conceptId));
  const fresh = (
    suggestions.ok
      ? suggestions.candidates.filter(
          (candidate) => !openConcepts.has(candidate.conceptId),
        )
      : []
  ).sort((a, b) => {
    if (a.conceptId === wanted) return -1;
    if (b.conceptId === wanted) return 1;
    return 0;
  });

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/student">Home</Link>}
        title="Practice"
        description={
          suggestions.ok
            ? "Untimed, and you find out straight away. Top of the list is what would help most."
            : undefined
        }
      />

      {unfinished.length > 0 && (
        // Offered first and by name. A half-done set a student cannot find
        // again is a set they start over, and starting over is the reason
        // people stop.
        <div className="ui-practice-resume">
          {unfinished.map((row) => (
            <Link key={row.id} href={`/student/practice/${row.id}`}>
              <span>
                <strong>Carry on with {row.conceptName}</strong>
                <span className="tabular">
                  {row.answered} of {row.questionCount} done
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}

      {!suggestions.ok ? (
        <EmptyState
          title={
            suggestions.reason === "nothing-to-practise"
              ? "Nothing needs work"
              : "Nothing to practise yet"
          }
          body={suggestions.message}
        />
      ) : fresh.length === 0 ? null : (
        <ul className="ui-practice-sets">
          {fresh.map((candidate) => (
            <li
              key={candidate.conceptId}
              className="ui-practice-set"
              data-reason={candidate.reason}
              data-from-plan={candidate.conceptId === wanted || undefined}
            >
              {candidate.conceptId === wanted && (
                <p className="ui-practice-set-flag">From your plan</p>
              )}
              <div className="ui-practice-set-body">
                <h2 className="ui-practice-set-title">{candidate.conceptName}</h2>
                {/*
                  The reason, in a sentence built from the numbers that produced
                  it. A recommendation a student cannot interrogate is one they
                  stop trusting the first time it is wrong.
                */}
                <p className="ui-practice-set-why">{candidate.rationale}</p>
                <p className="ui-practice-set-meta tabular">
                  {candidate.questionCount} questions · no timer
                </p>
              </div>
              <StartPractice
                conceptId={candidate.conceptId}
                questionCount={candidate.questionCount}
              />
            </li>
          ))}
        </ul>
      )}

      {history.filter((row) => row.completedAt !== null).length > 0 && (
        <>
          <h2 className="ui-section-heading">Done recently</h2>
          <ul className="ui-practice-history">
            {history
              .filter((row) => row.completedAt !== null)
              .map((row) => (
                <li key={row.id}>
                  <Link href={`/student/practice/${row.id}`}>
                    <span>{row.conceptName}</span>
                    <span className="tabular">
                      {Math.round((row.score ?? 0) * row.questionCount)} of{" "}
                      {row.questionCount}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </>
      )}

      <p className="ui-hint" style={{ marginTop: 18 }}>
        {/*
          Said plainly, because a student who thinks practice counts the same as
          a test will be surprised by their progress page — and because it is
          the honest description of what the number means.
        */}
        Practice counts towards your progress, but less than a test does — there
        is no one watching and the answer is a tap away. It is for learning the
        thing, not for proving it.
      </p>
    </StudentShell>
  );
}
