"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  buildResponse,
  isMultiSelect,
  parseNumber,
  toggleKey,
} from "@/core/attempts/response";
import type { Response } from "@/core/attempts/score";
import {
  next as nextInOutbox,
  pending as pendingFor,
  queue as queueEntry,
  settle as settleEntry,
  type Outbox,
} from "@/core/attempts/outbox";
import {
  empty as emptyOutbox,
  read as readOutbox,
  subscribe as subscribeToOutbox,
  write as writeOutbox,
} from "./outbox-store";
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
 * An answer is written to the device before it is sent
 * ---------------------------------------------------------------------------
 * The exam player has worked this way since it was built; practice did not, and
 * practice is the thing actually done at home on wifi that reaches the router
 * and nothing else. So pressing Check writes the answer to localStorage FIRST
 * and then sends it: a dropped request, a 500 and a dead tab all mean "not
 * now", the answer survives a reload, and it goes up by itself when the
 * connection returns.
 *
 * What it does NOT do is mark the answer here. The verdict is the server's —
 * the explanation and the key are absent from the payload until the answer
 * lands, because a set that arrives with the answers in it is a reading
 * exercise. So an answer given offline is KEPT and not judged, the screen says
 * exactly that, and the verdict appears when it gets through. Anything else
 * would either lie about the answer or ship the key to the device.
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

/**
 * `navigator.onLine` only knows about the radio, so it says "online" on a
 * school wifi that reaches nothing. The real signal is whether the last
 * request landed — the runner shows an offline state only when both agree,
 * which is the rule the exam player already follows.
 */
function subscribeToNetwork(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

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
  const [sendError, setSendError] = useState<string | null>(null);
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

  /**
   * Record a verdict the server sent back, and the question it served with it.
   *
   * One place, used by the first send and by every replay, so an answer that
   * landed on the second attempt produces exactly the screen it would have
   * produced on the first.
   */
  const applyVerdict = useCallback(
    (
      answerId: string,
      verdictFor: Verdict,
      finished: boolean,
      served: RunnerQuestion | null,
    ) => {
      setVerdicts((current) => ({ ...current, [answerId]: verdictFor }));
      // Appended, not replaced: the student is still reading the verdict on the
      // question they just answered, and the next one appears when they press
      // Next rather than under them.
      if (served) {
        setQuestions((current) =>
          current.some((row) => row.practiceAnswerId === served.practiceAnswerId)
            ? current
            : [...current, served],
        );
      }
      // So the progress page and the mistake bank reflect it on the way out.
      if (finished) router.refresh();
    },
    [router],
  );

  // ---- The outbox --------------------------------------------------------
  //
  // One per session, in localStorage, written BEFORE the request. Held here
  // rather than in the card because a card unmounts when the student moves on
  // and an unsent answer must not go with it.
  // Read through `useSyncExternalStore`, the right primitive for a browser
  // store — and the one this codebase already uses for the theme and for
  // `navigator.onLine`. Reading storage in a mount effect and calling setState
  // is a cascading render the linter rejects outright.
  const outbox = useSyncExternalStore(
    subscribeToOutbox,
    () => readOutbox(sessionId),
    emptyOutbox,
  );
  const [reachable, setReachable] = useState(true);
  const sendingRef = useRef(false);

  const browserOnline = useSyncExternalStore(
    subscribeToNetwork,
    () => navigator.onLine,
    () => true,
  );
  const online = browserOnline && reachable;

  const persist = useCallback(
    (nextOutbox: Outbox) => writeOutbox(sessionId, nextOutbox),
    [sessionId],
  );

  /**
   * Send the oldest unsent answer.
   *
   * Safe to call at any time, including when the answer already landed and the
   * reply was lost: the server replays the recorded verdict for an identical
   * answer rather than refusing it. That is what makes retrying honest instead
   * of hopeful.
   */
  const flush = useCallback(async (): Promise<void> => {
    if (sendingRef.current) return;
    const entry = nextInOutbox(readOutbox(sessionId));
    if (!entry) return;

    sendingRef.current = true;
    try {
      const result = await fetch(`/api/practice/sessions/${sessionId}/answers/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          practiceAnswerId: entry.id,
          response: entry.response,
          timeSpentSeconds: entry.timeSpentSeconds,
        }),
      });
      const json = await result.json().catch(() => null);
      if (!result.ok) {
        // A refusal is the server's decision and will not change on a retry —
        // drop it and say so, rather than sending it every thirty seconds
        // forever. Only "not now" stays queued.
        if (result.status >= 400 && result.status < 500) {
          persist(settleEntry(readOutbox(sessionId), entry.id));
          setSendError(json?.error?.message ?? "That answer was not accepted.");
          return;
        }
        setReachable(false);
        return;
      }

      setReachable(true);
      setSendError(null);
      persist(settleEntry(readOutbox(sessionId), entry.id));
      applyVerdict(
        entry.id,
        {
          correct: json.correct,
          explanation: json.explanation,
          correctAnswer: json.correctAnswer,
          correctKeys: json.correctKeys ?? null,
          chosen: chosenKeysOf(entry.response),
        },
        Boolean(json.finished),
        (json.next ?? null) as RunnerQuestion | null,
      );
    } catch {
      setReachable(false);
    } finally {
      sendingRef.current = false;
    }
  }, [applyVerdict, persist, sessionId]);

  // Anything the store already holds on load is sent: an answer given on a
  // train and reloaded in a station goes up without being retyped. Inside an
  // async function rather than in the effect body, the shape the exam player's
  // own restore uses — a setState called synchronously from an effect is a
  // cascading render, and the linter makes that an error rather than advice.
  useEffect(() => {
    let live = true;
    void (async () => {
      await Promise.resolve();
      if (live) await flush();
    })();
    return () => {
      live = false;
    };
  }, [flush]);

  // Retried the instant the network comes back, and on a slow timer as well,
  // because the radio is not the network: school wifi reaches the router and
  // fires no `online` event when the rest of it returns. Both are listeners,
  // which is where work that reacts to the browser belongs.
  useEffect(() => {
    const timer = setInterval(() => void flush(), 15_000);
    const onReconnect = () => void flush();
    window.addEventListener("online", onReconnect);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", onReconnect);
    };
  }, [flush]);

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
        question={question}
        verdict={verdict}
        helpOffered={helpOffered}
        saved={savedQuestionIds.includes(question.questionId)}
        // Queued, then sent. The card no longer talks to the network at all:
        // an unsent answer has to outlive the card, because the card unmounts
        // when the student moves on.
        unsent={pendingFor(outbox, question.practiceAnswerId) !== null}
        online={online}
        sendError={sendError}
        onAnswer={(response, timeSpentSeconds) => {
          setSendError(null);
          persist(
            queueEntry(readOutbox(sessionId), {
              id: question.practiceAnswerId,
              response,
              timeSpentSeconds,
              queuedAt: Date.now(),
              attempts: 0,
            }),
          );
          void flush();
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
  question,
  verdict,
  helpOffered,
  saved,
  unsent,
  online,
  sendError,
  onAnswer,
}: {
  question: RunnerQuestion;
  verdict: Verdict | undefined;
  helpOffered: boolean;
  saved: boolean;
  /** This answer is on the device and has not reached the server yet. */
  unsent: boolean;
  online: boolean;
  sendError: string | null;
  /** Hand the answer up. The Runner queues it and does the sending. */
  onAnswer: (response: Response, timeSpentSeconds: number) => void;
}) {
  const [keys, setKeys] = useState<string[]>([]);
  const [bool, setBool] = useState<boolean | null>(null);
  const [text, setText] = useState("");

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

  function submit() {
    if (response === null) return;
    // Handed up, not sent: the Runner writes it to the device first and owns
    // the retrying, because an unsent answer has to outlive this card.
    onAnswer(
      response,
      Math.min(3600, Math.max(0, Math.round((Date.now() - startedAt.current) / 1000))),
    );
  }

  return (
    <>
      <p className="ui-runner-stem">{question.stem}</p>

      {sendError && <p className="ui-practice-error">{sendError}</p>}

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
              disabled={!ready || unsent}
              onClick={submit}
            >
              <span>{unsent ? "Saved — sending…" : "Check"}</span>
            </button>
          </div>

          {unsent && (
            /*
              Three agreeing signals, the rule voice input already follows:
              the words, the dot, and the button above saying the same thing.
              Colour is never the only encoding — and the sentence has to be
              honest about what is and is not happening, because the one thing
              a student fears here is that the answer is gone.
            */
            <p className="ui-runner-unsent" role="status" data-offline={!online || undefined}>
              <span className="ui-runner-unsent-dot" aria-hidden="true" />
              {online
                ? "Saved on this device. Sending it now — the answer is not lost."
                : "Saved on this device. You are offline, so it will go up by itself when you are back — nothing is lost, and you will get the answer then."}
            </p>
          )}
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
