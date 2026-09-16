import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { recommendations, recentSessions } from "@/core/practice";
import { openForStudent } from "@/core/practice/assigned";
import { StudentShell } from "@/ui/StudentShell";
import { EmptyState, PageHeader } from "@/ui";
import { StartPractice } from "./StartPractice";

export const metadata: Metadata = { title: "Practice" };

export const dynamic = "force-dynamic";

const DUE = new Intl.DateTimeFormat("en-IN", {
  weekday: "long",
  day: "numeric",
  month: "short",
  timeZone: "Asia/Kolkata",
});
const dueLabel = (date: Date) => DUE.format(date);

export default async function PracticePage({
  searchParams,
}: {
  searchParams: Promise<{ conceptId?: string; assigned?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const actor = {
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
  };
  const [suggestions, history, assigned] = await Promise.all([
    recommendations(actor),
    recentSessions(actor, 8),
    openForStudent(actor.organizationId, actor.userId),
  ]);

  // A set opened from a teacher instruction is offered ONCE, on its own card
  // above, which carries who asked for it. Listing it again under "carry on"
  // would be the page arguing with itself — the same rule that keeps a concept
  // with an open set out of the recommendations below.
  const assignedSessions = new Set(
    assigned.map((set) => set.sessionId).filter((id): id is string => id !== null),
  );
  const unfinished = history.filter(
    (row) => row.completedAt === null && !assignedSessions.has(row.id),
  );

  // Arriving from the study plan, which named one concept. It is hoisted to the
  // top rather than filtered to, and a concept that is no longer a candidate —
  // because they practised it, or because the estimate moved — simply is not
  // there. That is the plan's own rule working: an item leaves when the
  // evidence changes, so following a stale link lands on the ordinary page
  // rather than on an error about something that is no longer true.
  const query = await searchParams;
  const wanted = query.conceptId ?? null;
  // Arriving from a teacher instruction in the plan. A withdrawn or finished
  // one is simply not in the list, so a stale link lands on the ordinary page
  // rather than on an error about something no longer true — the same rule the
  // concept link above follows.
  const fromTeacher = query.assigned
    ? (assigned.find((set) => set.id === query.assigned) ?? null)
    : null;

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

      {assigned.length > 0 && (
        // A teacher asked for these, so they sit above the product own
        // suggestions — and they say who asked, because "somebody asked" is a
        // different kind of reason from "this would help".
        <ul className="ui-practice-sets" aria-label="Set by your teacher">
          {assigned.map((set) => (
            <li
              key={set.id}
              className="ui-practice-set"
              data-assigned="true"
              data-from-plan={set.id === fromTeacher?.id || undefined}
            >
              <div className="ui-practice-set-body">
                <p className="ui-practice-set-flag">
                  Set by your {set.className} teacher
                </p>
                <h2 className="ui-practice-set-title">{set.conceptName}</h2>
                <p className="ui-practice-set-why">
                  {set.note ? set.note : "Untimed, with feedback after every question."}
                  {set.dueAt ? ` Asked for by ${dueLabel(set.dueAt)}.` : ""}
                </p>
                <p className="ui-practice-set-meta tabular">
                  {set.questionCount} questions · no timer · no marks
                </p>
              </div>
              {set.state === "IN_PROGRESS" && set.sessionId ? (
                <Link
                  href={`/student/practice/${set.sessionId}`}
                  className="ui-button"
                  data-variant="primary"
                  data-size="md"
                >
                  <span>Carry on</span>
                </Link>
              ) : (
                <StartPractice
                  conceptId={set.conceptId}
                  questionCount={set.questionCount}
                  assignedPracticeId={set.id}
                  label="Start this set"
                />
              )}
            </li>
          ))}
        </ul>
      )}

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
              <div className="ui-practice-set-body">
                {candidate.conceptId === wanted && (
                  <p className="ui-practice-set-flag">From your plan</p>
                )}
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
