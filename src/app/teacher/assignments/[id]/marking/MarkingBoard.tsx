"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Answer = {
  answerId: string;
  attemptId: string;
  studentName: string;
  response: string;
  marks: number;
  awardedMarks: number | null;
  feedback: string | null;
  gradeSource: string | null;
  rubricScores: { criterionId: string; marks: number; note?: string | null }[] | null;
};

type Criterion = {
  id: string;
  label: string;
  marks: number;
  descriptor?: string | null;
};

type Group = {
  assessmentQuestionId: string;
  position: number;
  type: string;
  stem: string;
  marks: number;
  expectedAnswer: string | null;
  explanation: string | null;
  /** The written mark scheme, when the question has one. Null is ordinary. */
  rubric: { criteria: Criterion[] } | null;
  answers: Answer[];
  unmarked: number;
};

/**
 * The marking board.
 *
 * One question at a time, every answer to it below — see the note in
 * core/results/marking for why that ordering is the whole point. The mark
 * scheme stays pinned at the top so the twentieth answer is judged against the
 * same standard as the first.
 *
 * Names are hidden by default. A marker who can see whose answer it is marks
 * differently, and knows they do not. Revealing them is one click away for the
 * moment a teacher genuinely needs to know.
 */
export function MarkingBoard({ groups }: { groups: Group[] }) {
  const router = useRouter();
  const [current, setCurrent] = useState(0);
  const [showNames, setShowNames] = useState(false);
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const group = groups[current];
  if (!group) return null;

  async function award(
    answer: Answer,
    payload:
      | { awardedMarks: number }
      | { scores: { criterionId: string; marks: number }[] },
    feedback: string,
  ) {
    setBusy(answer.answerId);
    setErrors((all) => ({ ...all, [answer.answerId]: "" }));

    try {
      const response = await fetch(`/api/marking/${answer.answerId}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, feedback: feedback || null }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setErrors((all) => ({
          ...all,
          [answer.answerId]:
            body?.error?.message ?? "We could not save that mark.",
        }));
        setBusy(null);
        return;
      }

      // The server derives the total from the criteria, so it is read back
      // from the response rather than recomputed here — two places computing
      // one number is two places to disagree.
      setSaved((all) => ({
        ...all,
        [answer.answerId]:
          "awardedMarks" in payload
            ? payload.awardedMarks
            : payload.scores.reduce((sum, score) => sum + score.marks, 0),
      }));
      setBusy(null);
      // The student's total moved the moment this landed, so the results page
      // behind this one is now stale.
      router.refresh();
    } catch {
      setErrors((all) => ({
        ...all,
        [answer.answerId]: "We could not reach the server. Try again.",
      }));
      setBusy(null);
    }
  }

  const remaining = group.answers.filter(
    (answer) => saved[answer.answerId] === undefined && answer.awardedMarks === null,
  ).length;

  return (
    <div className="ui-marking">
      <nav className="ui-marking-tabs" aria-label="Questions to mark">
        {groups.map((item, index) => (
          <button
            key={item.assessmentQuestionId}
            type="button"
            className="ui-marking-tab"
            data-current={index === current || undefined}
            onClick={() => setCurrent(index)}
          >
            <span className="tabular">Q{item.position}</span>
            {item.unmarked > 0 && (
              <span className="ui-marking-count tabular">{item.unmarked}</span>
            )}
          </button>
        ))}
      </nav>

      <section className="ui-scheme">
        <div className="ui-scheme-head">
          <span className="ui-item-position tabular">Q{group.position}</span>
          <span className="tabular">
            {group.marks} {group.marks === 1 ? "mark" : "marks"}
          </span>
          <button
            type="button"
            className="ui-link-button"
            onClick={() => setShowNames((on) => !on)}
            aria-pressed={showNames}
          >
            {showNames ? "Hide names" : "Show names"}
          </button>
        </div>

        <p className="ui-scheme-stem">{group.stem}</p>

        {(group.expectedAnswer || group.explanation) && (
          <div className="ui-scheme-key">
            <span className="ui-scheme-label">Mark scheme</span>
            {group.expectedAnswer && <p>{group.expectedAnswer}</p>}
            {group.explanation && <p>{group.explanation}</p>}
          </div>
        )}
      </section>

      <p className="ui-marking-progress">
        {remaining === 0
          ? "Every answer to this question is marked."
          : `${remaining} of ${group.answers.length} still to mark.`}
      </p>

      <ol className="ui-answers">
        {group.answers.map((answer, index) => (
          <AnswerRow
            key={answer.answerId}
            answer={answer}
            index={index}
            showName={showNames}
            savedMarks={saved[answer.answerId]}
            error={errors[answer.answerId]}
            busy={busy === answer.answerId}
            rubric={group.rubric}
            onAward={(payload, feedback) => void award(answer, payload, feedback)}
          />
        ))}
      </ol>
    </div>
  );
}

function AnswerRow({
  answer,
  index,
  showName,
  savedMarks,
  error,
  busy,
  rubric,
  onAward,
}: {
  answer: Answer;
  index: number;
  showName: boolean;
  savedMarks: number | undefined;
  error: string | undefined;
  busy: boolean;
  rubric: { criteria: Criterion[] } | null;
  onAward: (
    payload:
      | { awardedMarks: number }
      | { scores: { criterionId: string; marks: number }[] },
    feedback: string,
  ) => void;
}) {
  const settled = savedMarks ?? answer.awardedMarks;
  const [feedback, setFeedback] = useState(answer.feedback ?? "");
  // Open when there is already something to read; a link otherwise.
  const [commenting, setCommenting] = useState(Boolean(answer.feedback));

  // Whole marks and halves, because that is how a paper is actually marked —
  // and a row of buttons is one tap per answer where a number field is a tap,
  // a keyboard, a value and a submit.
  const steps: number[] = [];
  for (let value = 0; value <= answer.marks; value += 0.5) steps.push(value);

  // Per-criterion marks, when the question has a scheme. Seeded from whatever
  // was already awarded so re-opening a marked answer shows the breakdown that
  // produced its total rather than an empty form.
  const [criterionMarks, setCriterionMarks] = useState<Record<string, number>>(
    () =>
      Object.fromEntries(
        (answer.rubricScores ?? []).map((score) => [score.criterionId, score.marks]),
      ),
  );

  const allMarked =
    rubric !== null &&
    rubric.criteria.every((criterion) => criterionMarks[criterion.id] !== undefined);
  const rubricTotal = rubric
    ? rubric.criteria.reduce(
        (sum, criterion) => sum + (criterionMarks[criterion.id] ?? 0),
        0,
      )
    : 0;

  return (
    <li className="ui-answer" data-marked={settled !== null || undefined}>
      <div className="ui-answer-head">
        <span className="ui-answer-who">
          {showName ? answer.studentName : `Answer ${index + 1}`}
        </span>
        {settled !== null && (
          <span className="ui-answer-awarded tabular">
            {settled} / {answer.marks}
          </span>
        )}
      </div>

      <p className="ui-answer-text">{answer.response}</p>

      {rubric ? (
        /*
          One row per criterion. The total is NOT a button here — it is the sum
          of what the marker chose, shown live, because a marker who can set
          both can disagree with their own breakdown and the student is then
          shown a reason that does not add up to their mark.
        */
        <div className="ui-criteria">
          {rubric.criteria.map((criterion) => {
            const chosen = criterionMarks[criterion.id];
            const criterionSteps: number[] = [];
            for (let value = 0; value <= criterion.marks; value += 0.5) {
              criterionSteps.push(value);
            }
            return (
              <div key={criterion.id} className="ui-criterion">
                <span className="ui-criterion-label">
                  <strong>{criterion.label}</strong>
                  {criterion.descriptor && (
                    <span className="ui-criterion-descriptor">
                      {criterion.descriptor}
                    </span>
                  )}
                </span>
                <span className="ui-marks">
                  {criterionSteps.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className="ui-mark"
                      data-chosen={chosen === value || undefined}
                      disabled={busy}
                      onClick={() =>
                        setCriterionMarks((current) => ({
                          ...current,
                          [criterion.id]: value,
                        }))
                      }
                    >
                      {value}
                    </button>
                  ))}
                </span>
              </div>
            );
          })}

          <div className="ui-criteria-foot">
            <span className="ui-criteria-total tabular">
              {allMarked ? `${rubricTotal} / ${answer.marks}` : "Not yet marked"}
            </span>
            <button
              type="button"
              className="ui-button"
              data-variant="primary"
              data-size="sm"
              // Every criterion, or none. A partly filled scheme produces a
              // total that looks like a judgement and is an omission.
              disabled={!allMarked || busy}
              onClick={() =>
                onAward(
                  {
                    scores: rubric.criteria.map((criterion) => ({
                      criterionId: criterion.id,
                      marks: criterionMarks[criterion.id]!,
                    })),
                  },
                  feedback,
                )
              }
            >
              <span>{settled === null ? "Save mark" : "Update mark"}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="ui-marks">
          {steps.map((value) => (
            <button
              key={value}
              type="button"
              className="ui-mark"
              data-chosen={settled === value || undefined}
              disabled={busy}
              onClick={() => onAward({ awardedMarks: value }, feedback)}
            >
              {value}
            </button>
          ))}
        </div>
      )}

      {commenting ? (
        <textarea
          className="ui-textarea ui-answer-feedback"
          rows={2}
          placeholder="What would you tell this student?"
          aria-label="Feedback for this answer"
          value={feedback}
          autoFocus
          onChange={(event) => setFeedback(event.target.value)}
          // Saved with the mark, not on its own: a comment with no mark beside
          // it is a note the student never sees.
          onBlur={() => {
            if (settled === null || feedback === (answer.feedback ?? "")) return;
            // Re-saved the same way it was marked, so a comment added later
            // does not quietly convert a rubric mark into a typed total and
            // lose the breakdown the student was going to see.
            if (rubric && allMarked) {
              onAward(
                {
                  scores: rubric.criteria.map((criterion) => ({
                    criterionId: criterion.id,
                    marks: criterionMarks[criterion.id]!,
                  })),
                },
                feedback,
              );
            } else if (!rubric) {
              onAward({ awardedMarks: settled }, feedback);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="ui-link-button ui-comment-toggle"
          onClick={() => setCommenting(true)}
        >
          Add a comment
        </button>
      )}

      {error && (
        <p className="ui-error" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </p>
      )}
    </li>
  );
}
