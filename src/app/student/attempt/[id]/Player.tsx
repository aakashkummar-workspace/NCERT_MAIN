"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Response } from "@/core/attempts/score";
import {
  buildResponse,
  isBlankResponse,
  normaliseResponse,
  parseNumber,
  resumeSequence,
} from "@/core/attempts/response";
import { VoiceInput } from "@/ui/VoiceInput";
import { ClockIcon, CheckIcon, AlertTriangleIcon } from "@/ui/icons";

type Question = {
  assessmentQuestionId: string;
  position: number;
  marks: number;
  type: string;
  stem: string;
  options: { key: string; text: string }[] | null;
  response: Response;
  markedForReview: boolean;
  /** The sequence the server holds for this question. */
  clientSeq: number;
  timeSpentSeconds: number;
  visitCount: number;
};

type Pending = {
  assessmentQuestionId: string;
  response: Response;
  markedForReview: boolean;
  timeSpentSeconds?: number;
  visitCount?: number;
  clientSeq: number;
};

type Initial = {
  attemptId: string;
  title: string;
  serverTime: string;
  expiresAt: string;
  remainingMs: number;
  totalMarks: number;
  questions: Question[];
};

const queueKey = (attemptId: string) => `sahayak-queue-${attemptId}`;

/** Subscribes to the browser's own idea of connectivity. */
function subscribeToNetwork(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * The test player.
 *
 * Three properties, and everything here exists to hold them:
 *
 *   1. **The clock is derived, never counted.** We measure the offset between
 *      the server's clock and this device's once, then render
 *      `expiresAt - (deviceNow + offset)` on every tick. A tab backgrounded
 *      for forty minutes comes back correct; a counted-down number does not,
 *      because browsers throttle timers in hidden tabs and phones suspend them
 *      outright. The interval decides how often we *look* at the clock, never
 *      what the clock says.
 *
 *   2. **Work is never lost.** Every change goes into a queue in localStorage
 *      FIRST and flushes to the server after. Offline, a 500 and a dropped
 *      request all mean the same thing — "not now" — so the queue survives and
 *      retries. A refresh reloads it and carries on.
 *
 *   3. **Submitting is safe to repeat.** The server is idempotent, so a double
 *      tap, a retry after a timeout, and the sweep finishing the same paper
 *      from the other side all produce one result.
 */
export function Player({ initial }: { initial: Initial }) {
  const router = useRouter();

  const [questions, setQuestions] = useState(initial.questions);
  const [current, setCurrent] = useState(0);
  // Moving to another question starts it at its heading. Leaving a long
  // passage scrolled half-way down put the next question's number under the
  // sticky clock bar on a phone.
  const goTo = (next: (index: number) => number) => {
    setCurrent(next);
    window.scrollTo({ top: 0 });
  };
  const [remainingMs, setRemainingMs] = useState(initial.remainingMs);
  const [queueDepth, setQueueDepth] = useState(0);
  const [reachable, setReachable] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // deviceNow + offset === serverNow. Zero until the mount effect measures it;
  // until then the countdown runs off the server's own `remainingMs`, which is
  // already correct.
  const offsetRef = useRef(0);
  const expiresAtRef = useRef(new Date(initial.expiresAt).getTime());
  // Above the highest sequence the server already holds, never from 1.
  //
  // The server keeps a save only when its sequence beats the stored one. A
  // player that restarted at 1 on every load therefore had every edit to an
  // already-answered question ignored as "older" after a refresh — silently,
  // under a header that said Saved. Resuming above the stored maximum keeps
  // the ordering rule intact in both directions: this page's saves beat
  // everything before it, and a delayed batch from before the reload still
  // cannot overwrite them.
  const seqRef = useRef(resumeSequence(initial.questions));
  const queueRef = useRef<Map<string, Pending>>(new Map());
  const flushingRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const submittedRef = useRef(false);

  // What each question holds, for building a save outside an input handler —
  // leaving a question saves its time even when nothing was typed.
  const answersRef = useRef<
    Map<string, { response: Response; markedForReview: boolean }>
  >(
    new Map(
      initial.questions.map((item) => [
        item.assessmentQuestionId,
        { response: item.response, markedForReview: item.markedForReview },
      ]),
    ),
  );

  // Time and visits, as running totals per question. Totals rather than
  // increments, so a save that is retried or overtaken cannot double-count.
  // Both feed the CARELESS rule in core/mistakes/classify, which needs a real
  // time to set against the author's estimate and a real count of visits.
  const timeMsRef = useRef<Map<string, number>>(
    new Map(
      initial.questions.map((item) => [
        item.assessmentQuestionId,
        item.timeSpentSeconds * 1000,
      ]),
    ),
  );
  const visitsRef = useRef<Map<string, number>>(
    new Map(
      initial.questions.map((item) => [item.assessmentQuestionId, item.visitCount]),
    ),
  );
  // The question on screen, and when this stretch of looking at it began. Null
  // while the page is hidden: a phone in a pocket is not time on a question.
  const stintRef = useRef<{ id: string; since: number | null } | null>(null);
  const lastVisitedRef = useRef<string | null>(null);

  // The raw text in each number box, kept apart from the response. "0.0" on
  // its way to "0.05" is not a number yet, and rewriting it into one while the
  // student is typing is what made small decimals impossible to enter.
  const [numberDrafts, setNumberDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initial.questions.flatMap((item) =>
        item.response?.kind === "numeric"
          ? [[item.assessmentQuestionId, String(item.response.value)]]
          : [],
      ),
    ),
  );

  // navigator.onLine only knows about the radio, so it says "online" on a
  // school wifi that reaches nothing. The real signal is whether the last
  // request actually landed — a student is told they are offline only when
  // both agree.
  const browserOnline = useSyncExternalStore(
    subscribeToNetwork,
    () => navigator.onLine,
    () => true,
  );
  const online = browserOnline && reachable;

  // ---- The queue ---------------------------------------------------------

  const persistQueue = useCallback(() => {
    try {
      localStorage.setItem(
        queueKey(initial.attemptId),
        JSON.stringify([...queueRef.current.values()]),
      );
    } catch {
      // Private window, or storage full. The in-memory queue still flushes;
      // only surviving a refresh is lost, and that is not worth an error
      // message on top of a test.
    }
    setQueueDepth(queueRef.current.size);
  }, [initial.attemptId]);

  const flush = useCallback(async (): Promise<void> => {
    // A flush already on the wire is waited for, not skipped. Skipping it let
    // Submit close the paper while the last answer was still in flight.
    if (flushingRef.current) {
      await inFlightRef.current;
      if (flushingRef.current || queueRef.current.size === 0) return;
    }
    if (queueRef.current.size === 0) return;
    flushingRef.current = true;
    let settle: () => void = () => {};
    inFlightRef.current = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const batch = [...queueRef.current.values()];
    try {
      const response = await fetch(
        `/api/attempts/${initial.attemptId}/answers/`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: batch }),
        },
      );

      if (!response.ok) {
        setReachable(false);
        return;
      }

      const payload = await response.json();

      // Only what we actually sent is dropped. Anything typed while the
      // request was in flight carries a higher seq and stays queued.
      for (const item of batch) {
        const queued = queueRef.current.get(item.assessmentQuestionId);
        if (queued && queued.clientSeq === item.clientSeq) {
          queueRef.current.delete(item.assessmentQuestionId);
        }
      }
      persistQueue();
      setReachable(true);

      // Every successful save is also a time check, so a long paper stays
      // honest without extra round trips.
      if (typeof payload?.serverTime === "string") {
        offsetRef.current = new Date(payload.serverTime).getTime() - Date.now();
      }
    } catch {
      setReachable(false);
    } finally {
      flushingRef.current = false;
      settle();
    }
  }, [initial.attemptId, persistQueue]);

  // Measured once, at mount. Recomputing this later from `initial.serverTime`
  // would be wrong — that stamp ages with the page, and the offset would drift
  // by exactly the time the student has been sitting the paper.
  useEffect(() => {
    offsetRef.current = new Date(initial.serverTime).getTime() - Date.now();
  }, [initial.serverTime]);

  /** Puts answers recovered from the device's queue back on screen. */
  const applyRestored = useCallback(
    (restored: Map<string, Pending>) => {
      persistQueue();
      if (restored.size === 0) return;
      setQuestions((all) =>
        all.map((item) => {
          const found = restored.get(item.assessmentQuestionId);
          return found
            ? {
                ...item,
                response: found.response,
                markedForReview: found.markedForReview,
              }
            : item;
        }),
      );
      setNumberDrafts((drafts) => {
        const next = { ...drafts };
        for (const [id, item] of restored) {
          if (item.response?.kind === "numeric") {
            next[id] = String(item.response.value);
          } else if (item.response === null) {
            delete next[id];
          }
        }
        return next;
      });
    },
    [persistQueue],
  );

  // Restore anything queued before a refresh, a crash, or a battery running
  // out. Sequence numbers resume above the highest one seen, so a restored
  // answer still cannot be overtaken by an older one.
  //
  // And what is restored goes ON SCREEN, not only into the queue. It used to be
  // re-queued and never shown: the navigator said unanswered, the textarea was
  // empty, and the first keystroke overwrote the restored answer. A queued item
  // the server has already overtaken is dropped instead — the server's copy is
  // newer, and it is what the page loaded with.
  useEffect(() => {
    let stored: Pending[] = [];
    try {
      const raw = localStorage.getItem(queueKey(initial.attemptId));
      if (raw) stored = JSON.parse(raw) as Pending[];
    } catch {
      // An unreadable queue starts clean rather than crashing the student into
      // a broken player.
      return;
    }
    if (!Array.isArray(stored) || stored.length === 0) return;

    const held = new Map(
      initial.questions.map((item) => [item.assessmentQuestionId, item.clientSeq]),
    );
    const restored = new Map<string, Pending>();
    for (const item of stored) {
      const serverSeq = held.get(item.assessmentQuestionId);
      if (serverSeq === undefined || item.clientSeq <= serverSeq) continue;
      restored.set(item.assessmentQuestionId, item);
      queueRef.current.set(item.assessmentQuestionId, item);
      seqRef.current = Math.max(seqRef.current, item.clientSeq + 1);
      answersRef.current.set(item.assessmentQuestionId, {
        response: item.response,
        markedForReview: item.markedForReview,
      });
      const id = item.assessmentQuestionId;
      if (item.timeSpentSeconds !== undefined) {
        timeMsRef.current.set(
          id,
          Math.max(timeMsRef.current.get(id) ?? 0, item.timeSpentSeconds * 1000),
        );
      }
      if (item.visitCount !== undefined) {
        visitsRef.current.set(
          id,
          Math.max(visitsRef.current.get(id) ?? 0, item.visitCount),
        );
      }
    }
    // Applied after the effect rather than inside it. The queue lives in the
    // browser, not in React, so this is a read of an external store landing —
    // and a state update inside the effect body would render twice for it.
    let live = true;
    queueMicrotask(() => {
      if (live) applyRestored(restored);
    });
    return () => {
      live = false;
    };
  }, [applyRestored, initial.attemptId, initial.questions]);

  // Flush on a timer, when the page is hidden — which on a phone is the moment
  // the student switches app or the screen locks — and the instant the network
  // comes back, which is the one event worth not waiting five seconds for.
  useEffect(() => {
    const timer = setInterval(() => void flush(), 5000);
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const onReconnect = () => void flush();

    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("online", onReconnect);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("online", onReconnect);
    };
  }, [flush]);

  // ---- Time on each question ---------------------------------------------

  /** Adds the stretch since `since` to the question on screen. */
  const accrue = useCallback(() => {
    const stint = stintRef.current;
    if (!stint || stint.since === null) return;
    const now = Date.now();
    timeMsRef.current.set(
      stint.id,
      (timeMsRef.current.get(stint.id) ?? 0) + Math.max(0, now - stint.since),
    );
    stint.since = now;
  }, []);

  /**
   * Queue a save of one question as it stands: answer, flag, time and visits.
   *
   * Queued FIRST, flushed after. If the tab dies between the two, the answer
   * is already on the device and goes up on the next load.
   */
  const enqueue = useCallback(
    (questionId: string) => {
      const answer = answersRef.current.get(questionId);
      if (!answer) return;
      accrue();
      queueRef.current.set(questionId, {
        assessmentQuestionId: questionId,
        response: normaliseResponse(answer.response),
        markedForReview: answer.markedForReview,
        timeSpentSeconds: Math.min(
          86_400,
          Math.round((timeMsRef.current.get(questionId) ?? 0) / 1000),
        ),
        visitCount: visitsRef.current.get(questionId) ?? 0,
        clientSeq: seqRef.current++,
      });
      persistQueue();
      void flush();
    },
    [accrue, flush, persistQueue],
  );

  const currentId = initial.questions[current]?.assessmentQuestionId ?? null;

  // A visit is counted when a question comes on screen, and its time is saved
  // when it leaves — so a question looked at for two minutes and left blank
  // still says two minutes. Counted against the last question visited rather
  // than on every run of the effect, so the same question re-rendering is not
  // a second visit.
  useEffect(() => {
    if (currentId === null) return;
    if (lastVisitedRef.current !== currentId) {
      lastVisitedRef.current = currentId;
      visitsRef.current.set(currentId, (visitsRef.current.get(currentId) ?? 0) + 1);
    }
    stintRef.current = {
      id: currentId,
      since: document.visibilityState === "hidden" ? null : Date.now(),
    };
    return () => {
      // After submitting there is nothing to save to, and a save queued now
      // would outlive the paper in this device's storage.
      if (submittedRef.current) return;
      enqueue(currentId);
      stintRef.current = null;
    };
  }, [currentId, enqueue]);

  useEffect(() => {
    const onVisibility = () => {
      const stint = stintRef.current;
      if (!stint) return;
      if (document.visibilityState === "hidden") {
        accrue();
        stint.since = null;
      } else if (stint.since === null) {
        stint.since = Date.now();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [accrue]);

  // ---- Submitting --------------------------------------------------------

  const submit = useCallback(
    async (reason: "MANUAL" | "TIMEOUT") => {
      if (submittedRef.current) return;
      // The question on screen has time on it that no navigation has saved.
      if (stintRef.current) enqueue(stintRef.current.id);
      submittedRef.current = true;
      setSubmitting(true);
      setConfirming(false);
      setError(null);

      // Everything typed goes up before the paper is closed.
      await flush();

      try {
        const response = await fetch(
          `/api/attempts/${initial.attemptId}/submit/`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason }),
          },
        );

        if (!response.ok) {
          submittedRef.current = false;
          setSubmitting(false);
          setError(
            "We could not submit just now. Your answers are saved — try again.",
          );
          return;
        }

        try {
          localStorage.removeItem(queueKey(initial.attemptId));
        } catch {
          // Nothing to do about it, and nothing at stake: the server has the
          // answers, which is the copy that counts.
        }

        router.replace(`/student/results/${initial.attemptId}`);
        router.refresh();
      } catch {
        submittedRef.current = false;
        setSubmitting(false);
        setError(
          "We could not reach the server. Your answers are saved on this device — try again when you are back online.",
        );
      }
    },
    [enqueue, flush, initial.attemptId, router],
  );

  // ---- The clock ---------------------------------------------------------

  useEffect(() => {
    const tick = () => {
      const serverNow = Date.now() + offsetRef.current;
      const left = Math.max(0, expiresAtRef.current - serverNow);
      setRemainingMs(left);
      if (left === 0) void submit("TIMEOUT");
    };

    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [submit]);

  // A device whose clock drifts mid-exam must not drift with it, and a student
  // who has answered nothing for ten minutes still needs a true clock.
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch(
          `/api/attempts/${initial.attemptId}/heartbeat/`,
          { method: "POST" },
        );
        if (!response.ok) {
          setReachable(false);
          return;
        }
        const payload = await response.json();
        offsetRef.current = new Date(payload.serverTime).getTime() - Date.now();
        expiresAtRef.current = new Date(payload.expiresAt).getTime();
        setReachable(true);
      } catch {
        setReachable(false);
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [initial.attemptId]);

  // ---- Answering ---------------------------------------------------------

  const record = (questionId: string, patch: Partial<Question>) => {
    const existing = questions.find(
      (item) => item.assessmentQuestionId === questionId,
    );
    if (!existing) return;
    const merged = { ...existing, ...patch };

    setQuestions((all) =>
      all.map((item) =>
        item.assessmentQuestionId === questionId ? merged : item,
      ),
    );

    answersRef.current.set(questionId, {
      response: merged.response,
      markedForReview: merged.markedForReview,
    });
    enqueue(questionId);
  };

  const question = questions[current];
  if (!question) return null;

  const answered = questions.filter((item) => hasAnswer(item.response)).length;
  const blank = questions.length - answered;
  const minutes = Math.floor(remainingMs / 60_000);
  const seconds = Math.floor((remainingMs % 60_000) / 1000);
  const urgent = remainingMs > 0 && remainingMs < 5 * 60_000;

  return (
    <div className="ui-player">
      <header className="ui-player-bar">
        <span className="ui-player-title">{initial.title}</span>

        <span
          className="ui-player-clock tabular"
          data-urgent={urgent || undefined}
        >
          <ClockIcon size={16} />
          <span>{String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}</span>
        </span>

        {/*
          Announced at thresholds rather than on every tick. A live region on
          the clock itself would read the time aloud sixty times a minute,
          which makes a screen reader useless for the questions.
        */}
        <span className="sr-only" role="status" aria-live="polite">
          {remainingMs === 0
            ? "Time is up."
            : minutes < 1
              ? "Less than a minute left."
              : minutes < 5
                ? "Five minutes left."
                : ""}
        </span>

        <span className="ui-player-state">
          {!online ? (
            <span className="ui-player-offline">
              <AlertTriangleIcon size={14} />
              <span>Offline — saved on device</span>
            </span>
          ) : queueDepth > 0 ? (
            <span className="ui-player-saving">Saving…</span>
          ) : (
            <span className="ui-player-saved">
              <CheckIcon size={14} />
              <span>Saved</span>
            </span>
          )}
        </span>
      </header>

      {error && (
        <p className="ui-player-error" role="alert">
          {error}
        </p>
      )}

      <div className="ui-player-body">
        <main className="ui-player-question">
          <div className="ui-player-meta">
            <span>
              Question {current + 1} of {questions.length}
            </span>
            <span className="tabular">
              {question.marks} {question.marks === 1 ? "mark" : "marks"}
            </span>
          </div>

          <p className="ui-player-stem">{question.stem}</p>

          {question.options && (
            <fieldset className="ui-player-options">
              <legend className="sr-only">Choose an answer</legend>
              {question.options.map((option) => {
                const keys =
                  question.response?.kind === "choice"
                    ? question.response.keys
                    : [];
                const chosen = keys.includes(option.key);
                const multi = question.type === "MULTI_SELECT";
                return (
                  <label
                    key={option.key}
                    className="ui-player-option"
                    data-chosen={chosen || undefined}
                  >
                    <input
                      type={multi ? "checkbox" : "radio"}
                      name={`q-${question.assessmentQuestionId}`}
                      checked={chosen}
                      onChange={(event) => {
                        const next = multi
                          ? event.target.checked
                            ? [...keys, option.key]
                            : keys.filter((key) => key !== option.key)
                          : [option.key];
                        record(question.assessmentQuestionId, {
                          // Nothing ticked is blank, not an empty answer.
                          response: buildResponse({
                            type: question.type,
                            hasOptions: true,
                            keys: next,
                            bool: null,
                            text: "",
                          }),
                        });
                      }}
                    />
                    <span className="ui-player-option-key">{option.key}</span>
                    <span>{option.text}</span>
                  </label>
                );
              })}
            </fieldset>
          )}

          {question.type === "TRUE_FALSE" && (
            <div className="ui-player-options">
              {[true, false].map((value) => (
                <label
                  key={String(value)}
                  className="ui-player-option"
                  data-chosen={
                    (question.response?.kind === "boolean" &&
                      question.response.value === value) ||
                    undefined
                  }
                >
                  <input
                    type="radio"
                    name={`q-${question.assessmentQuestionId}`}
                    checked={
                      question.response?.kind === "boolean" &&
                      question.response.value === value
                    }
                    onChange={() =>
                      record(question.assessmentQuestionId, {
                        response: { kind: "boolean", value },
                      })
                    }
                  />
                  <span className="ui-player-option-key">
                    {value ? "T" : "F"}
                  </span>
                  <span>{value ? "True" : "False"}</span>
                </label>
              ))}
            </div>
          )}

          {question.type === "NUMERIC" && (
            <NumberAnswer
              id={question.assessmentQuestionId}
              text={numberDrafts[question.assessmentQuestionId] ?? ""}
              onChange={(text) => {
                setNumberDrafts((drafts) => ({
                  ...drafts,
                  [question.assessmentQuestionId]: text,
                }));
                record(question.assessmentQuestionId, {
                  // An empty box is unanswered, not zero — the same rule the
                  // marker applies at the other end. The box keeps exactly
                  // what was typed; only the response is a number.
                  response: buildResponse({
                    type: "NUMERIC",
                    hasOptions: false,
                    keys: [],
                    bool: null,
                    text,
                  }),
                });
              }}
            />
          )}

          {TEXT_TYPES.has(question.type) && (
            <>
              {question.type === "CASE_STUDY" && (
                // One box for several parts, so each answer carries its part
                // number — the teacher marks against a rubric row per part.
                <p className="ui-hint" id={`case-hint-${question.assessmentQuestionId}`}>
                  Answer every part, each on its own line, starting with its number —
                  for example &ldquo;(i) b&rdquo;, &ldquo;(ii) because…&rdquo;.
                </p>
              )}
              <textarea
                className="ui-textarea ui-player-input"
                rows={ROWS[question.type] ?? 3}
                aria-label="Your answer"
                aria-describedby={
                  question.type === "CASE_STUDY" ? `case-hint-${question.assessmentQuestionId}` : undefined
                }
                value={
                  question.response?.kind === "text"
                    ? question.response.value
                    : ""
                }
                onChange={(event) =>
                  record(question.assessmentQuestionId, {
                    response: { kind: "text", value: event.target.value },
                  })
                }
              />
              {/*
                Dictation goes through `record` — the same handler the textarea's
                own onChange uses — so a spoken answer is queued to localStorage
                and flushed exactly like a typed one. There is no second
                persistence path, and nothing about autosave, the offline queue
                or the sequence numbers has to know that voice exists.

                It renders nothing at all where the browser has no
                SpeechRecognition, so a student on Firefox sees the paper they
                saw yesterday. The textarea above is untouched and stays
                editable throughout: dictated text is a draft, not a verdict.
              */}
              <VoiceInput
                value={
                  question.response?.kind === "text"
                    ? question.response.value
                    : ""
                }
                onChange={(next) =>
                  record(question.assessmentQuestionId, {
                    response: { kind: "text", value: next },
                  })
                }
              />
            </>
          )}

          <div className="ui-player-nav">
            <button
              type="button"
              className="ui-button"
              data-variant="secondary"
              data-size="lg"
              onClick={() => goTo((index) => Math.max(0, index - 1))}
              disabled={current === 0}
            >
              <span>Previous</span>
            </button>
            <button
              type="button"
              className="ui-button"
              // Secondary, not ghost. Between two outlined buttons a ghost
              // reads as a caption rather than a control, and a student under
              // a clock should not have to discover that it is clickable.
              data-variant={question.markedForReview ? "primary" : "secondary"}
              data-size="lg"
              aria-pressed={question.markedForReview}
              onClick={() =>
                record(question.assessmentQuestionId, {
                  markedForReview: !question.markedForReview,
                })
              }
            >
              <span>
                {question.markedForReview ? "Marked" : "Mark for review"}
              </span>
            </button>
            <button
              type="button"
              className="ui-button"
              data-variant="secondary"
              data-size="lg"
              onClick={() =>
                goTo((index) => Math.min(questions.length - 1, index + 1))
              }
              disabled={current === questions.length - 1}
            >
              <span>Next</span>
            </button>
          </div>
        </main>

        <aside className="ui-player-side">
          <nav aria-label="Questions">
            <ol className="ui-navigator">
              {questions.map((item, index) => {
                const state = item.markedForReview
                  ? "review"
                  : hasAnswer(item.response)
                    ? "answered"
                    : "blank";
                return (
                  <li key={item.assessmentQuestionId}>
                    <button
                      type="button"
                      className="ui-navigator-item"
                      data-state={index === current ? "current" : state}
                      onClick={() => goTo(() => index)}
                      aria-current={index === current ? "true" : undefined}
                      aria-label={`Question ${index + 1}, ${LABEL[state]}`}
                    >
                      {index + 1}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <p className="ui-player-progress tabular">
            {answered} of {questions.length} answered
          </p>

          <button
            type="button"
            className="ui-button"
            data-variant="primary"
            data-size="lg"
            data-full="true"
            disabled={submitting}
            onClick={() => setConfirming(true)}
          >
            <span>{submitting ? "Submitting…" : "Submit"}</span>
          </button>
        </aside>
      </div>

      {confirming && (
        // Submitting is the one irreversible thing a student can do here, so it
        // asks first — and says what it is about to cost them, in the numbers
        // they care about, rather than issuing a general warning.
        <div className="ui-confirm-backdrop" role="presentation">
          <div
            className="ui-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-body"
          >
            <h2 id="confirm-title" className="ui-confirm-title">
              Submit your answers?
            </h2>
            <p id="confirm-body" className="ui-confirm-body">
              {blank > 0
                ? `${blank} ${blank === 1 ? "question is" : "questions are"} still blank. `
                : "All questions are answered. "}
              You cannot come back to this paper afterwards.
            </p>
            <div className="ui-confirm-actions">
              <button
                type="button"
                className="ui-button"
                data-variant="secondary"
                data-size="lg"
                onClick={() => setConfirming(false)}
                autoFocus
              >
                <span>Keep working</span>
              </button>
              <button
                type="button"
                className="ui-button"
                data-variant="primary"
                data-size="lg"
                onClick={() => void submit("MANUAL")}
              >
                <span>Submit</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The types answered by writing. CASE_STUDY was missing, so a case study or an
 * unseen passage rendered its passage and every part and then offered nowhere
 * to answer: a screenshot of the player caught it, after 145 of them had been
 * imported. Scoring and the marking queue already treated it as written.
 */
const TEXT_TYPES = new Set(["FILL_BLANK", "VSA", "SA", "LA", "CASE_STUDY"]);

/** Room to write roughly what the mark is worth. */
const ROWS: Record<string, number> = {
  FILL_BLANK: 2,
  VSA: 3,
  SA: 6,
  LA: 10,
  CASE_STUDY: 12,
};

const LABEL = {
  answered: "answered",
  review: "marked for review",
  blank: "not answered",
} as const;

/**
 * Answered, for the navigator and the count.
 *
 * Whitespace is not an answer, and neither is an empty selection — a student
 * who ticks an option and unticks it must see the square go back to blank, or
 * the progress count lies to them at exactly the wrong moment.
 */
function hasAnswer(response: Response): boolean {
  return !isBlankResponse(response);
}

/**
 * The number box.
 *
 * `type="text"` with a decimal keypad, not `type="number"`. A number input
 * reports an empty value for text it cannot parse yet — "-" on the way to
 * "-0.5" — so a controlled one wipes what the student is halfway through
 * typing. The raw text lives in the player; this only says, quietly, when what
 * is in the box would not be read as a number.
 */
function NumberAnswer({
  id,
  text,
  onChange,
}: {
  id: string;
  text: string;
  onChange: (text: string) => void;
}) {
  const unreadable = text.trim() !== "" && parseNumber(text) === null;
  return (
    <>
      <input
        className="ui-input ui-player-input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label="Your answer"
        aria-invalid={unreadable || undefined}
        aria-describedby={unreadable ? `number-note-${id}` : undefined}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
      {unreadable && (
        <p className="ui-hint" id={`number-note-${id}`}>
          That is not a number yet, so it counts as blank. Use digits, a decimal
          point, and a minus sign if you need one.
        </p>
      )}
    </>
  );
}
