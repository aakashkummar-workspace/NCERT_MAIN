import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { getMistake, retryMessage } from "@/core/mistakes/read";
import { helpSoFar, tutorOffered } from "@/core/tutor";
import { StudentShell } from "@/ui/StudentShell";
import { Badge, PageHeader } from "@/ui";
import { Retry } from "./Retry";
import { AskForHelp } from "../../_tutor/AskForHelp";
import { savedQuestionIds } from "@/core/saved";
import { SaveQuestion } from "../../_saved/SaveQuestion";

export const metadata: Metadata = { title: "One to fix" };

export const dynamic = "force-dynamic";

/** What they put, rendered for reading rather than as stored JSON. */
function describeResponse(
  response: unknown,
  options: { key: string; text: string }[] | null,
): string | null {
  if (!response || typeof response !== "object") return null;
  const value = response as Record<string, unknown>;

  if (value.kind === "choice" && Array.isArray(value.keys)) {
    const keys = value.keys as string[];
    if (keys.length === 0) return null;
    return keys
      .map((key) => {
        const option = options?.find((candidate) => candidate.key === key);
        return option ? `${key}. ${option.text}` : key;
      })
      .join("  ·  ");
  }
  if (value.kind === "boolean") return value.value === true ? "True" : "False";
  if (value.kind === "numeric") return String(value.value ?? "");
  if (value.kind === "text") return String(value.value ?? "");
  return null;
}

export default async function MistakePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const { id } = await params;
  const mistake = await getMistake(
    session.actor.organizationId,
    session.actor.userId,
    id,
  );
  if (!mistake) notFound();

  // What they have already been given on this question, so a reload does not
  // look like the help was never there.
  const actor = {
    organizationId: session.actor.organizationId,
    userId: session.actor.userId,
  };
  const [help, offered, saved] = await Promise.all([
    helpSoFar(actor, mistake.questionId),
    tutorOffered(actor.organizationId),
    savedQuestionIds(actor.organizationId, actor.userId, [mistake.questionId]),
  ]);

  const given = describeResponse(mistake.originalResponse, mistake.options);

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        eyebrow={<Link href="/student/mistakes">Things to fix</Link>}
        title={mistake.conceptName ?? "One to fix"}
        description={
          mistake.chapters.length > 0 ? mistake.chapters.join(" · ") : undefined
        }
      />

      <article className="ui-mistake-detail">
        <div className="ui-mistake-detail-tags">
          {mistake.classified ? (
            <Badge tone="neutral">{mistake.typeLabel}</Badge>
          ) : mistake.examined ? (
            // Looked at, and there was nothing to say. Different from the line
            // below: saying "not looked at yet" here would promise an answer
            // that is never coming, and the reason underneath explains it.
            <Badge tone="neutral">No clear reason</Badge>
          ) : (
            // Honest rather than helpful-sounding. A heading invented for a
            // mistake nothing has read would be the product guessing at a
            // student about their own work.
            <Badge tone="neutral">Not looked at yet</Badge>
          )}
          <span className="ui-mistake-detail-marks tabular">
            {mistake.awarded === null
              ? `${mistake.marks} ${mistake.marks === 1 ? "mark" : "marks"}`
              : `${mistake.awarded} of ${mistake.marks}`}
          </span>
          <SaveQuestion
            questionId={mistake.questionId}
            initiallySaved={saved.has(mistake.questionId)}
          />
        </div>

        <p className="ui-mistake-detail-stem">{mistake.stem}</p>

        {/*
          Listed here only once they have retried. Before that the retry panel
          below shows the same options as buttons, and printing them twice made
          the page half again as long for no gain.
        */}
        {mistake.options && mistake.options.length > 0 && mistake.revealed && (
          <ul className="ui-mistake-detail-options">
            {mistake.options.map((option) => (
              <li key={option.key}>
                <span className="ui-mistake-detail-key">{option.key}</span>
                <span>{option.text}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="ui-mistake-detail-given">
          {/*
            "In the test", once they have retried. The retry's own answer is
            not stored, so a bare "You put" under a revealed page read as what
            they had just entered — and it was the original.
          */}
          <span className="ui-mistake-detail-label">
            {mistake.revealed ? "In the test you put" : "You put"}
          </span>
          {given ?? "Nothing — you left this one blank."}
        </p>

        {/*
          The type's reason, when something decided one. This is the line that
          makes the whole feature worth building: "you got this wrong" is a
          fact they already had.
        */}
        {mistake.typeReason && (
          <p className="ui-mistake-detail-reason">{mistake.typeReason}</p>
        )}

        {/*
          Advice is about the attempt they are about to make ("have another
          go"), so it goes once they have made it. Left up, it sat above a page
          with no control on it to act on.
        */}
        {!mistake.revealed && (
          <p className="ui-mistake-detail-advice">{mistake.advice}</p>
        )}
      </article>

      {mistake.revealed ? (
        <article className="ui-mistake-detail" data-revealed="true">
          {/*
            The verdict, from the stored retry rather than from the response.
            The retry panel unmounts the moment the page refreshes into this
            state, and the verdict used to go with it before anybody could read
            it.
          */}
          {mistake.lastRetryCorrect !== null && (
            <div
              className="ui-retry"
              data-outcome={mistake.lastRetryCorrect ? "correct" : "wrong"}
            >
              <p className="ui-retry-verdict" role="status">
                {mistake.lastRetryCorrect
                  ? "Right this time."
                  : "Still not right."}
              </p>
              <p className="ui-retry-message">
                {retryMessage(mistake.lastRetryCorrect)}
              </p>
            </div>
          )}
          {mistake.correctAnswer && (
            <p className="ui-mistake-detail-given">
              <span className="ui-mistake-detail-label">The answer</span>
              {mistake.correctAnswer}
            </p>
          )}
          {mistake.explanation && (
            <p className="ui-mistake-detail-explanation">{mistake.explanation}</p>
          )}
          {mistake.status !== "RESOLVED" && (
            <p className="ui-hint" style={{ marginTop: 12 }}>
              {/*
                Told plainly, so a student is never surprised that it is still
                on their list after they got it right.
              */}
              This stays on your list until you get a{" "}
              <strong>different question</strong> on this idea right. Getting
              the same one right again mostly means you remembered the answer.
            </p>
          )}
        </article>
      ) : (
        <>
          <Retry
            mistakeId={mistake.id}
            type={mistake.type}
            options={mistake.options}
          />
          {/*
            Under the retry, never above it. Help offered before the attempt is
            help taken instead of the attempt, and the attempt is the thing
            this page exists for.
          */}
          {/*
            Not rendered at all on a plan without the tutor. A panel whose only
            button can answer "not part of your plan" is a dead control, and a
            student cannot do anything about their school's plan. Help already
            given stays visible, though — it was given.
          */}
          {(offered || (help?.turns.length ?? 0) > 0) && (
            <AskForHelp
              questionId={mistake.questionId}
              studentMistakeId={mistake.id}
              initialTurns={help?.turns ?? []}
              initialCanEscalate={offered && (help?.canEscalate ?? true)}
            />
          )}
        </>
      )}
    </StudentShell>
  );
}
