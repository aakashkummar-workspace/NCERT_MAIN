import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listMistakes, mistakeSummary } from "@/core/mistakes/read";
import { StudentShell } from "@/ui/StudentShell";
import { Badge, EmptyState, PageHeader, type Tone } from "@/ui";

export const metadata: Metadata = { title: "Things to fix" };

export const dynamic = "force-dynamic";

/**
 * "Things to fix", not "Your mistakes".
 *
 * The page is a to-do list, and a fifteen-year-old opening a tab labelled with
 * their own failures opens it once. The heading names the work, not the person.
 */
const STATUS_TONE: Record<string, Tone> = {
  UNRESOLVED: "warning",
  RETRIED: "primary",
  RESOLVED: "success",
};

const STATUS_LABEL: Record<string, string> = {
  UNRESOLVED: "To do",
  RETRIED: "Had another go",
  RESOLVED: "Fixed",
};

export default async function MistakesPage() {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const [mistakes, summary] = await Promise.all([
    listMistakes(session.actor.organizationId, session.actor.userId, {
      includeResolved: true,
    }),
    mistakeSummary(session.actor.organizationId, session.actor.userId),
  ]);

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/student">Home</Link>}
        title="Things to fix"
        description={
          mistakes.length === 0
            ? "Questions you got wrong turn up here after a test, so you can come back to them."
            : summary.worst
              ? `Most of these are about ${summary.worst.conceptName}. That is where to start.`
              : "The ones you have not had another go at are first."
        }
      />

      {mistakes.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          body="Questions you get wrong appear here once a test has been marked, with the explanation and a chance to try them again. An empty page is a good page."
        />
      ) : (
        <>
          {summary.resolved > 0 && (
            // Progress, stated first. A list that only ever grows is a list a
            // student stops opening.
            <p className="ui-mistake-progress">
              <strong className="tabular">{summary.resolved}</strong>{" "}
              {summary.resolved === 1 ? "has" : "have"} been fixed —
              you got a different question on the same idea right afterwards.
            </p>
          )}

          <ul className="ui-mistakes">
            {mistakes.map((mistake) => (
              <li key={mistake.id} className="ui-mistake" data-status={mistake.status}>
                <Link href={`/student/mistakes/${mistake.id}`}>
                  <span className="ui-mistake-head">
                    {/*
                      The QUESTION is the heading, not the concept. A whole
                      list headed "Similarity of triangles" three times over
                      tells a student nothing about which is which — and the
                      concept is already in the sentence at the top of the page.
                    */}
                    <span className="ui-mistake-stem">{mistake.stem}</span>
                    <span className="ui-mistake-tags">
                      {/*
                        The type when something named one; "no clear reason"
                        when something looked and could not. Nothing at all
                        while nothing has looked — a heading invented for an
                        unread mistake would be the product guessing at a
                        student about their own work.
                      */}
                      {mistake.classified ? (
                        <Badge tone="neutral">{mistake.typeLabel}</Badge>
                      ) : mistake.examined ? (
                        <Badge tone="neutral">No clear reason</Badge>
                      ) : null}
                      <Badge tone={STATUS_TONE[mistake.status] ?? "neutral"}>
                        {STATUS_LABEL[mistake.status] ?? mistake.status}
                      </Badge>
                    </span>
                  </span>

                  <span className="ui-mistake-meta">
                    {mistake.conceptName && <>{mistake.conceptName}{" · "}</>}
                    {/*
                      "1 of 3" rather than a bare "wrong". An answer that was
                      most of the way there is not the same as a blank one, and
                      flattening the two is how a student learns nothing from
                      the page.
                    */}
                    <span className="tabular">
                      {mistake.awarded === null
                        ? `${mistake.marks} ${mistake.marks === 1 ? "mark" : "marks"}`
                        : `${mistake.awarded} of ${mistake.marks}`}
                    </span>
                    {mistake.retryCount > 0 && (
                      <>
                        {" · "}
                        {mistake.retryCount}{" "}
                        {mistake.retryCount === 1 ? "retry" : "retries"}
                      </>
                    )}
                    {" · "}
                    {new Intl.DateTimeFormat("en-IN", {
                      dateStyle: "medium",
                      timeZone: "Asia/Kolkata",
                    }).format(mistake.occurredAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="ui-hint" style={{ marginTop: 18 }}>
        {/*
          Said out loud, because it is what makes the page worth anything. A
          list you can tick off yourself measures how tidy you are.
        */}
        A question moves to <strong>Fixed</strong> on its own, when you get a
        different question on the same idea right. There is no button for it —
        getting the same one right twice mostly means you remembered the answer.
      </p>
    </StudentShell>
  );
}
