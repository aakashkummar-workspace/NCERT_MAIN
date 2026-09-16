"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  buildResponse,
  isMultiSelect,
  parseNumber,
  toggleKey,
} from "@/core/attempts/response";
import { AskForHelp } from "../../_tutor/AskForHelp";
import { SaveQuestion } from "../../_saved/SaveQuestion";

/**
 * The practice runner.
 *
 * One question on screen, answered, and the verdict *immediately* — that is the
 * entire difference between this and the exam player, and every decision below
 * follows from it. No clock, no navigator, no "mark for review", no submit.
 * Those exist in the test player to manage pressure, and there is no pressure
 * here to manage.
 *
 * The student moves on themselves rather than being advanced automatically:
 * being told you were wrong and then having the explanation slide away is worse
 * than not being told.
 *
 * ---------------------------------------------------------------------------
 * One card per question, keyed
 * ---------------------------------------------------------------------------
 * The per-question state — what they have selected, whether a request is in
 * flight — lives in `QuestionCard`, keyed on the answer id. Moving to the next
 * question unmounts one card and mounts another, so the inputs reset because
 * they are new, not because an effect cleared them. Resetting state from an
 * effect is a cascading render and the linter rejects it; this is the shape
 * that rule is pointing at.
 */

export type RunnerQuestion = {
  practiceAnswerId: string;
  questionId: string;
  position: number;
  type: string;
  stem: string;
  options: { key: string; text: string }[] | null;
  response: unknown;
  isCorrect: boolean | null;
  explanation: string | null;
  correctAnswer: string | null;
  correctKeys: string[] | null;
};

type Verdict = {
  correct: boolean;
  explanation: string | null;
  correctAnswer: string | null;
  correctKeys: string[] | null;
  /**
   * What they actually tapped, so their options can be marked as theirs.
   * Every key on a multi-select, not just the first.
   */
  chosen: string[];
};

/** Which keys they tapped, read back from a stored response. */
function chosenKeysOf(response: unknown): string[] {
  if (!response || typeof response !== "object") return [];
  const value = response as Record<string, unknown>;
  if (value.kind === "choice" && Array.isArray(value.keys)) {
    return value.keys as string[];
  }
  if (value.kind === "boolean") return [value.value === true ? "T" : "F"];
  return [];
}

/** A typed answer read back from a stored response, for a resumed set. */
function describeGiven(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const value = response as Record<string, unknown>;
  if (value.kind === "text" && typeof value.value === "string") return value.value;
  if (value.kind === "numeric" && typeof value.value === "number") {
    return String(value.value);
  }
  return "";
}

export function Runner({
  sessionId,
  conceptName,
  questions: initialQuestions,
  questionCount,
  helpOffered,
  savedQuestionIds = [],
}: {
  sessionId: string;
  conceptName: string;
  questions: RunnerQuestion[];
  /** How many the set is aiming for. The list grows towards it. */
  questionCount: number;
  /**
   * Whether the school's plan includes the tutor. Without it there is no help
   * panel at all — not one whose only answer is a refusal, sitting under a
   * warning that taking the help costs the question its evidence.
   */
  helpOffered: boolean;
  /** Questions in this set the student has already saved, read on the server. */
  savedQuestionIds?: string[];
}) {
  const router = useRouter();

  // Questions arrive one at a time, each chosen from how the set has gone so
  // far. The list starts with whatever was already served and grows as answers
  // come back — see `nextDifficulty` in core/practice/adapt.ts.
  const [questions, setQuestions] = useState<RunnerQuestion[]>(initialQuestions);

  // Open at the first unanswered question, so a resumed set carries on rather
  // than making them tap past what they already did.
  const firstOpen = questions.findIndex((question) => question.isCorrect === null);
  const [index, setIndex] = useState(
    firstOpen === -1 ? Math.max(0, questions.length - 1) : firstOpen,
  );
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>(() =>
    Object.fromEntries(
      questions
        .filter((question) => question.isCorrect !== null)
        .map((question) => [
          question.practiceAnswerId,
          {
            correct: question.isCorrect === true,
            explanation: question.explanation,
            correctAnswer: question.correctAnswer,
            correctKeys: question.correctKeys,
            chosen: chosenKeysOf(question.response),
          },
        ]),
    ),
  );

  const question = questions[index];
  if (!question) return null;

  const verdict = verdicts[question.practiceAnswerId];
  const answered = verdict !== undefined;
  // The last one is whichever is at the end of the list AND had no successor
  // served — the set ends when the adaptation stops finding questions.
  const last = index === questions.length - 1;
  const done = questions.every(
    (item) => verdicts[item.practiceAnswerId] !== undefined,
  );
  const correctCount = Object.values(verdicts).filter((v) => v.correct).length;

  return (
    <div className="ui-runner">
      <div className="ui-runner-progress">
        <span className="tabular">
          {index + 1} of {Math.max(questionCount, questions.length)}
        </span>
        {/*
          A bar, not a clock. It says how much is left, which is the only thing
          about time a student needs on an untimed screen.
        */}
        <span className="ui-runner-bar" aria-hidden="true">
          <span
            style={{
              width: `${((index + 1) / Math.max(questionCount, questions.length)) * 100}%`,
            }}
          />
        </span>
        <span className="tabular">{correctCount} right</span>
      </div>

      <QuestionCard
        key={question.practiceAnswerId}
        sessionId={sessionId}
        question={question}
        verdict={verdict}
        helpOffered={helpOffered}
        saved={savedQuestionIds.includes(question.questionId)}
        onAnswered={(answerId, next, finished, served) => {
          setVerdicts((current) => ({ ...current, [answerId]: next }));
          // Appended, not replaced: the student is still reading the verdict on
          // the question they just answered, and the next one appears when they
          // press Next rather than under them.
          if (served) {
            setQuestions((current) =>
              current.some((row) => row.practiceAnswerId === served.practiceAnswerId)
                ? current
                : [...current, served],
            );
          }
          // So the progress page and the mistake bank reflect it on the way out.
          if (finished) router.refresh();
        }}
      />

      <div className="ui-runner-actions">
        {!answered ? null : last ? (
          done ? (
            <Link
              href="/student/practice"
              className="ui-button"
              data-variant="primary"
              data-size="lg"
            >
              <span>
                Finished — {correctCount} of {questions.length} right
              </span>
            </Link>
          ) : (
            // They skipped forward and left gaps behind. Sent back rather than
            // allowed to "finish" a set they have not done.
            <button
              type="button"
              className="ui-button"
              data-variant="secondary"
              data-size="lg"
              onClick={() =>
                setIndex(
                  questions.findIndex(
                    (item) => verdicts[item.practiceAnswerId] === undefined,
                  ),
                )
              }
            >
              <span>Back to the ones you skipped</span>
            </button>
          )
        ) : (
          <button
            type="button"
            className="ui-button"
            data-variant="primary"
            data-size="lg"
            onClick={() => setIndex((current) => current + 1)}
          >
            <span>Next question</span>
          </button>
        )}

        {index > 0 && (
          <button
            type="button"
            className="ui-button"
            data-variant="ghost"
            data-size="lg"
            onClick={() => setIndex((current) => current - 1)}
          >
            <span>Back</span>
          </button>
        )}
      </div>

      <p className="ui-hint" style={{ marginTop: 16 }}>
        No timer on this. {conceptName} — take as long as you like, and leave it
        half done if you want; it will be here.
      </p>
    </div>
  );
}

function QuestionCard({
  sessionId,
  question,
  verdict,
  helpOffered,
  saved,
  onAnswered,
}: {
  sessionId: string;
  question: RunnerQuestion;
  verdict: Verdict | undefined;
  helpOffered: boolean;
  saved: boolean;
  onAnswered: (
    answerId: string,
    verdict: Verdict,
    finished: boolean,
    served: RunnerQuestion | null,
  ) => void;
}) {
  const [keys, setKeys] = useState<string[]>([]);
  const [bool, setBool] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Time on THIS question. Measured in a mount effect rather than at render:
  // `useRef(Date.now())` during render is the purity rule the linter enforces.
  const startedAt = useRef(0);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  const choiceType = question.options !== null && question.options.length > 0;
  const booleanType = question.type === "TRUE_FALSE";
  const answered = verdict !== undefined;
  const numericType = question.type === "NUMERIC" && !choiceType;
  const multi = isMultiSelect(question.type);

  // Built by the same helper the exam player uses, so a number goes as a
  // number and a multi-select carries every tick. Both used to be wrong here:
  // a right number was marked wrong as text, and a two-answer question could
  // never be got right from one key.
  const response = buildResponse({
    type: question.type,
    hasOptions: choiceType,
    keys,
    bool,
    text,
  });
  const ready = response !== null;
  const unreadable = numericType && text.trim() !== "" && parseNumber(text) === null;

  async function submit() {
    if (response === null) return;
    setPending(true);
    setError(null);
    try {
      const result = await fetch(`/api/practice/sessions/${sessionId}/answers/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          practiceAnswerId: question.practiceAnswerId,
          response,
          timeSpentSeconds: Math.min(
            3600,
            Math.max(0, Math.round((Date.now() - startedAt.current) / 1000)),
          ),
        }),
      });
      const json = await result.json().catch(() => null);
      if (!result.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      onAnswered(
        question.practiceAnswerId,
        {
          correct: json.correct,
          explanation: json.explanation,
          correctAnswer: json.correctAnswer,
          correctKeys: json.correctKeys ?? null,
          chosen: choiceType ? keys : booleanType ? [bool ? "T" : "F"] : [],
        },
        Boolean(json.finished),
        (json.next ?? null) as RunnerQuestion | null,
      );
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p className="ui-runner-stem">{question.stem}</p>

      {error && <p className="ui-practice-error">{error}</p>}

      {choiceType && multi && !answered && (
        <p className="ui-hint">More than one option may be right. Tick every one that is.</p>
      )}

      {choiceType && (
        <ul className="ui-runner-options">
          {question.options!.map((option) => {
            const picked = keys.includes(option.key);
            // Before answering, "chosen" is the only state an option can be in.
            // Afterwards it is replaced by right/wrong: leaving the tapped
            // option in the accent colour reads as approval sitting directly
            // above the words "not this time".
            const mark = !answered
              ? undefined
              : verdict.correctKeys?.includes(option.key)
                ? "correct"
                : verdict.chosen.includes(option.key)
                  ? "wrong"
                  : undefined;
            return (
              <li key={option.key}>
                <button
                  type="button"
                  className="ui-runner-option"
                  disabled={answered}
                  aria-pressed={picked}
                  data-chosen={(!answered && picked) || undefined}
                  data-mark={mark}
                  onClick={() =>
                    setKeys((current) => toggleKey(question.type, current, option.key))
                  }
                >
                  <span className="ui-runner-option-key">{option.key}</span>
                  <span>{option.text}</span>
                  {/* Colour is never the only encoding. */}
                  {mark === "wrong" && (
                    <span className="ui-runner-option-tag">You chose this</span>
                  )}
                  {mark === "correct" && (
                    <span className="ui-runner-option-tag">Correct</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {booleanType && !choiceType && (
        <ul className="ui-runner-options">
          {[true, false].map((value) => {
            const key = value ? "T" : "F";
            const theirs = verdict?.chosen.includes(key) ?? false;
            // With two options the verdict alone identifies the right one, so
            // this needs no key list from the server.
            const mark = !answered
              ? undefined
              : theirs
                ? verdict.correct
                  ? "correct"
                  : "wrong"
                : verdict.correct
                  ? undefined
                  : "correct";
            return (
              <li key={key}>
                <button
                  type="button"
                  className="ui-runner-option"
                  disabled={answered}
                  aria-pressed={bool === value}
                  data-chosen={(!answered && bool === value) || undefined}
                  data-mark={mark}
                  onClick={() => setBool(value)}
                >
                  <span className="ui-runner-option-key">{key}</span>
                  <span>{value ? "True" : "False"}</span>
                  {mark === "wrong" && (
                    <span className="ui-runner-option-tag">You chose this</span>
                  )}
                  {mark === "correct" && (
                    <span className="ui-runner-option-tag">Correct</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!choiceType && !booleanType && (
        <label className="ui-runner-field">
          <span>Your answer</span>
          <input
            type="text"
            className="ui-input"
            // A decimal keypad for a number, and the text kept exactly as typed.
            inputMode={numericType ? "decimal" : undefined}
            autoComplete="off"
            aria-invalid={unreadable || undefined}
            value={answered && text === "" ? describeGiven(question.response) : text}
            disabled={answered}
            onChange={(event) => setText(event.target.value)}
          />
          {unreadable && <span className="ui-hint">That is not a number yet.</span>}
        </label>
      )}

      {answered ? (
        <div
          className="ui-runner-verdict"
          data-outcome={verdict.correct ? "correct" : "wrong"}
        >
          <p className="ui-runner-verdict-head">
            {verdict.correct ? "Right." : "Not this time."}
          </p>
          {/*
            Only where there is nothing on screen to mark — a typed answer.
            With options, the one marked Correct above says it better than a
            sentence underneath repeating it.
          */}
          {!verdict.correct &&
            verdict.correctAnswer &&
            question.options === null &&
            question.type !== "TRUE_FALSE" && (
              <p className="ui-runner-answer">
                <span className="ui-runner-answer-label">The answer</span>
                {verdict.correctAnswer}
              </p>
            )}
          {/*
            The explanation is the reason this screen exists. It arrives while
            the student's own reasoning is still in their head, which is the one
            moment it can change anything.
          */}
          {verdict.explanation && (
            <p className="ui-runner-explanation">{verdict.explanation}</p>
          )}
          {/*
            Offered once it is answered, never before: a bookmark on a question
            they have not tried yet is a way of skipping it.
          */}
          <SaveQuestion questionId={question.questionId} initiallySaved={saved} />
        </div>
      ) : (
        <>
          <div className="ui-runner-actions">
            <button
              type="button"
              className="ui-button"
              data-variant="primary"
              data-size="lg"
              disabled={!ready || pending}
              onClick={() => void submit()}
            >
              <span>{pending ? "Checking…" : "Check"}</span>
            </button>
          </div>
          {/*
            Offered while they are stuck, which is the only moment it is worth
            anything — and gone once the verdict and the explanation are on
            screen, where a help button would be offering to explain something
            already explained.

            Keyed on the question so moving to the next one mounts a fresh
            panel rather than carrying the last one's hints across, the same
            reason the card itself is keyed.
          */}
          {helpOffered && (
            <AskForHelp
              key={question.practiceAnswerId}
              questionId={question.questionId}
              practiceAnswerId={question.practiceAnswerId}
              costsEvidence
            />
          )}
        </>
      )}
    </>
  );
}
