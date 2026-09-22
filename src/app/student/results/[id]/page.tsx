import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { studentResult } from "@/core/attempts/student-view";
import type { Response } from "@/core/attempts/score";
import { markFeedbackSeen } from "@/core/student/feedback";
import { resultQuestionIds } from "@/core/student/result-questions";
import { savedQuestionIds } from "@/core/saved";
import { StudentShell } from "@/ui/StudentShell";
import { Alert, Badge, PageHeader } from "@/ui";
import { SaveQuestion } from "../../_saved/SaveQuestion";

export const metadata: Metadata = { title: "Result" };

export const dynamic = "force-dynamic";

export default async function ResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/teacher");

  const { id } = await params;
  const result = await studentResult(
    session.actor.organizationId,
    session.actor.userId,
    id,
  );
  if (!result) notFound();

  // Only now, with the read authorised: the student has opened their own
  // result, so any teacher comment on it is no longer "new" on Home. Stamped
  // only when the comments can actually be READ — before the answers open the
  // feedback is withheld, and marking it seen would swallow the prompt on the
  // day it becomes readable.
  const reviewOpen = result.visible && result.reviewable;
  const { organizationId, userId } = session.actor;

  // Which question is at each position, and which of those are saved — for
  // "Save for later" in the review. Read only when the review is open; before
  // that there is nothing on this page a student would want to come back to.
  const [questionIds] = await Promise.all([
    reviewOpen
      ? resultQuestionIds(organizationId, userId, result.attemptId)
      : Promise.resolve(new Map<number, string>()),
    reviewOpen
      ? markFeedbackSeen(organizationId, userId, result.attemptId)
      : Promise.resolve(),
  ]);
  const saved =
    questionIds.size > 0
      ? await savedQuestionIds(organizationId, userId, [...questionIds.values()])
      : new Set<string>();

  return (
    <StudentShell
      fullName={session.fullName}
      organizationName={session.organizationName}
    >
      <PageHeader
        title={result.title}
        description={
          result.submittedAt
            ? `Submitted ${result.submittedAt.toLocaleString("en-IN", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "Asia/Kolkata",
              })}`
            : "Not submitted."
        }
        actions={
          <Link href="/student" className="ui-button" data-variant="secondary">
            <span>Back to my tests</span>
          </Link>
        }
      />

      {!result.visible ? (
        // No score is shown, and none was sent from the server either. The
        // message says which of the two reasons applies, because "nothing here"
        // reads as a lost paper.
        <Alert tone="info">
          Your answers are safely submitted. Your teacher has not released the
          result for this test yet — it will appear here when they do.
        </Alert>
      ) : (
        <>
          <section className="ui-result-score">
            <div className="ui-result-headline">
              <span className="ui-result-number tabular">
                {result.rawScore}
              </span>
              <span className="ui-result-outof tabular">
                / {result.maxScore}
              </span>
            </div>

            {/*
              A percentage is only shown once the paper is fully marked. On a
              paper with written answers still waiting on a teacher, "0.0%"
              under a big zero tells a student they failed — when in truth
              nobody has looked at their work yet.
            */}
            {result.pendingMarks > 0 ? (
              <>
                <p className="ui-result-percent">marked so far</p>
                <Badge tone="warning">
                  {result.pendingMarks}{" "}
                  {result.pendingMarks === 1 ? "mark is" : "marks are"} still to
                  be marked by your teacher
                </Badge>
              </>
            ) : (
              <p className="ui-result-percent tabular">
                {result.percentage.toFixed(1)}%
              </p>
            )}
          </section>

          <h2 className="ui-section-heading">Question by question</h2>

          {!result.reviewable && (
            // Said, rather than left as an absence. A student who taps a
            // question and gets nothing assumes the app is broken.
            <p className="ui-review-note">
              The answers open once everyone has finished the paper.
            </p>
          )}

          <ol className="ui-breakdown">
            {result.breakdown.map((item) => {
              /*
                Five states. "You left this blank" and "nobody has marked this
                yet" both show no score, and telling a student they are the same
                thing makes a blank paper look like a marking backlog. Partial
                credit is its own state too — 2 out of 3 is neither a tick nor a
                cross.
              */
              const summary = (
                <>
                  <span
                    className="ui-breakdown-mark"
                    data-state={state(item)}
                    aria-hidden="true"
                  >
                    {GLYPH[state(item)]}
                  </span>
                  <span className="ui-breakdown-body">
                    <span className="ui-breakdown-position tabular">
                      Q{item.number}
                    </span>
                    <span className="ui-breakdown-stem">{item.stem}</span>
                  </span>
                  <span className="sr-only">{DESCRIPTION[state(item)]}</span>
                  <span className="ui-breakdown-score tabular">
                    {/*
                      Null is not zero. An answer nobody has marked yet is shown
                      as unmarked, never as a score of nought — that difference
                      is the whole point of the marking rules.
                    */}
                    {item.awardedMarks === null
                      ? `— / ${item.marks}`
                      : `${item.awardedMarks} / ${item.marks}`}
                  </span>
                </>
              );

              if (!result.reviewable) {
                return (
                  <li key={item.position} className="ui-breakdown-item">
                    {summary}
                  </li>
                );
              }

              return (
                <li key={item.position}>
                  {/*
                    A native <details>. It opens with no JavaScript at all, so a
                    student on a school connection that dropped the bundle still
                    gets the answers.
                  */}
                  <details className="ui-review">
                    <summary className="ui-breakdown-item">{summary}</summary>

                    <div className="ui-review-body">
                      {item.options ? (
                        <ul className="ui-review-options">
                          {item.options.map((option) => {
                            const chose =
                              item.response?.kind === "choice" &&
                              item.response.keys.includes(option.key);
                            return (
                              <li
                                key={option.key}
                                data-correct={option.isCorrect || undefined}
                                data-chose={chose || undefined}
                              >
                                <span className="ui-player-option-key">
                                  {option.key}
                                </span>
                                <span className="ui-review-option-text">
                                  {option.text}
                                </span>
                                {chose && (
                                  <span className="ui-review-tag">You</span>
                                )}
                                {option.isCorrect && (
                                  <span
                                    className="ui-review-tag"
                                    data-tone="correct"
                                  >
                                    Correct
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <>
                          <p className="ui-review-label">Your answer</p>
                          <p className="ui-review-text">
                            {describeResponse(item.response) ??
                              "You left this blank."}
                          </p>
                          {item.correctAnswer && (
                            <>
                              <p className="ui-review-label">The answer</p>
                              <p className="ui-review-text">
                                {item.correctAnswer}
                              </p>
                            </>
                          )}
                        </>
                      )}

                      {/*
                        Where the marks went. The reason a rubric exists:
                        "2.5 out of 3" tells a student there is something wrong
                        and not what, and the next paper goes the same way.
                      */}
                      {item.breakdown && (
                        <>
                          <p className="ui-review-label">Where the marks went</p>
                          <ul className="ui-criteria-list">
                            {item.breakdown.map((row) => (
                              <li key={row.label}>
                                <span className="ui-criteria-label">{row.label}</span>
                                <span className="ui-criteria-marks tabular">
                                  {row.marks} / {row.outOf}
                                </span>
                                {row.note && (
                                  <span className="ui-criteria-note">{row.note}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}

                      {item.feedback && (
                        <>
                          <p className="ui-review-label">Your teacher wrote</p>
                          <p className="ui-review-text" data-tone="feedback">
                            {item.feedback}
                          </p>
                        </>
                      )}

                      {item.explanation && (
                        <>
                          <p className="ui-review-label">Why</p>
                          <p className="ui-review-text">{item.explanation}</p>
                        </>
                      )}

                      {/*
                        Last, after the answer and the reason: saving is what a
                        student does once they have read why, not before.
                      */}
                      {questionIds.has(item.position) && (
                        <div className="ui-sd-review-save">
                          <SaveQuestion
                            questionId={questionIds.get(item.position)!}
                            initiallySaved={saved.has(questionIds.get(item.position)!)}
                          />
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </StudentShell>
  );
}

type Row = { awardedMarks: number | null; marks: number; answered: boolean };
type State = "correct" | "partial" | "wrong" | "blank" | "pending";

/**
 * Derived from the marks, not from `isCorrect`.
 *
 * A partially marked answer stores `isCorrect: null` — 2 out of 3 is genuinely
 * neither — and reading that field first would put it in the same box as an
 * answer nobody has marked yet.
 */
function state(item: Row): State {
  if (item.awardedMarks === null) return item.answered ? "pending" : "blank";
  if (item.awardedMarks >= item.marks) return "correct";
  if (item.awardedMarks <= 0) return "wrong";
  return "partial";
}

/** The student's own answer, in words. */
function describeResponse(response: Response): string | null {
  if (response === null) return null;
  if (response.kind === "text") {
    return response.value.trim().length > 0 ? response.value : null;
  }
  if (response.kind === "numeric") return String(response.value);
  if (response.kind === "boolean") return response.value ? "True" : "False";
  if (response.kind === "choice") {
    return response.keys.length > 0 ? response.keys.join(", ") : null;
  }
  // A paper sat on paper: the answer is on their script, not here.
  if (response.kind === "paper") return "Written on your answer script.";
  return null;
}

const GLYPH: Record<State, string> = {
  correct: "✓",
  partial: "½",
  wrong: "✕",
  blank: "–",
  pending: "…",
};

const DESCRIPTION: Record<State, string> = {
  correct: "Correct.",
  partial: "Some of the marks.",
  wrong: "Not correct.",
  blank: "You left this blank.",
  pending: "Waiting to be marked.",
};
