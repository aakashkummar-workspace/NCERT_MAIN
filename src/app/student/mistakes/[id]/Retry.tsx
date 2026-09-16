"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  buildResponse,
  isMultiSelect,
  parseNumber,
  toggleKey,
} from "@/core/attempts/response";
import {
  next as nextInOutbox,
  pending as pendingInOutbox,
  queue as queueEntry,
  settle as settleEntry,
} from "@/core/attempts/outbox";
import {
  empty as emptyOutbox,
  read as readOutbox,
  subscribe as subscribeToOutbox,
  write as writeOutbox,
} from "./outbox-store";

/**
 * One more go at the question, then the explanation.
 *
 * The order is the whole design. The answer is on the server behind a check
 * that they have retried, so a student cannot read the explanation first — and
 * the value of a mistake bank is entirely in the attempt that comes before it.
 *
 * The response is built by `core/attempts/response`, the same helper the exam
 * player and the practice runner use. This component used to send every typed
 * answer as text — which the numeric marker does not read, so a right number
 * was marked wrong — and a multi-select as one key, so a question with two
 * right options could never be got right.
 *
 * ---------------------------------------------------------------------------
 * The retry is written to the device before it is sent
 * ---------------------------------------------------------------------------
 * The same queue practice uses (`core/attempts/outbox`), for the same reason:
 * this is homework, done on wifi that reaches the router and nothing else, and
 * an answer that vanishes because a request did is the failure the exam player
 * fixed long ago.
 *
 * One thing differs here, and it needed a column. A retry INCREMENTS a count
 * and stamps a date, and both are read — the page shows the count and the
 * mistake classifier's CARELESS rule uses the number of visits. So the device
 * mints a key before the first send, and a replay carrying the same key gets
 * the recorded verdict with nothing written. A key the server invented would
 * be a new key every time, which is the bug it exists to prevent: the
 * reasoning `clientAttemptId` already follows on a sitting.
 */

/**
 * `navigator.onLine` only knows about the radio, so it says "online" on a
 * school wifi that reaches nothing. The real signal is whether the last
 * request landed — the rule the exam player and the practice runner follow.
 */
function subscribeToNetwork(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

type Option = { key: string; text: string };

export type RetryOutcome = {
  correct: boolean;
  explanation: string | null;
  correctAnswer: string | null;
  message: string;
};

export function Retry({
  mistakeId,
  type,
  options,
}: {
  mistakeId: string;
  type: string;
  options: Option[] | null;
}) {
  const router = useRouter();
  const [keys, setKeys] = useState<string[]>([]);
  const [bool, setBool] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RetryOutcome | null>(null);
  const [reachable, setReachable] = useState(true);
  const sendingRef = useRef(false);

  // localStorage read the way a browser store is read here: through
  // `useSyncExternalStore`, never an effect that calls setState.
  const outbox = useSyncExternalStore(
    subscribeToOutbox,
    () => readOutbox(mistakeId),
    emptyOutbox,
  );
  const unsent = pendingInOutbox(outbox, mistakeId) !== null;

  const browserOnline = useSyncExternalStore(
    subscribeToNetwork,
    () => navigator.onLine,
    () => true,
  );
  const online = browserOnline && reachable;

  const choiceType = options !== null && options.length > 0;
  const booleanType = type === "TRUE_FALSE";
  const numericType = type === "NUMERIC" && !choiceType;
  const multi = isMultiSelect(type);

  const response = buildResponse({
    type,
    hasOptions: choiceType,
    keys,
    bool,
    text,
  });
  const ready = response !== null;
  const unreadable = numericType && text.trim() !== "" && parseNumber(text) === null;

  /**
   * Send what is on the device, and keep it there until the server has it.
   *
   * Safe to call at any time, including when the retry already landed and the
   * reply was lost: the key it carries makes the server replay the recorded
   * verdict rather than count a second go.
   */
  const flush = useCallback(async (): Promise<void> => {
    if (sendingRef.current) return;
    const entry = nextInOutbox(readOutbox(mistakeId));
    if (!entry) return;

    sendingRef.current = true;
    try {
      const result = await fetch(`/api/student/mistakes/${mistakeId}/retry/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: entry.response,
          clientRetryId: entry.clientKey,
        }),
      });
      const json = await result.json().catch(() => null);
      if (!result.ok) {
        // A refusal is the server's decision and will not change on a retry —
        // a written answer nobody can mark, say. Dropped and said, rather than
        // re-sent every fifteen seconds forever.
        if (result.status >= 400 && result.status < 500) {
          writeOutbox(mistakeId, settleEntry(readOutbox(mistakeId), mistakeId));
          setError(json?.error?.message ?? "Something went wrong. Try again.");
          return;
        }
        setReachable(false);
        return;
      }

      setReachable(true);
      setError(null);
      writeOutbox(mistakeId, settleEntry(readOutbox(mistakeId), mistakeId));
      setOutcome(json as RetryOutcome);
      // The page comes back revealed, and carries the verdict itself from the
      // stored retry — so the result stays on screen after this component has
      // gone, and on any later visit.
      router.refresh();
    } catch {
      setReachable(false);
    } finally {
      sendingRef.current = false;
    }
  }, [mistakeId, router]);

  // Anything already on the device goes up — including a retry given before
  // the phone locked. Inside an async function rather than in the effect body:
  // a setState called synchronously from an effect is a cascading render, which
  // the linter makes an error rather than advice.
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

  // And again the instant the network returns, and on a slow timer, because
  // the radio is not the network.
  useEffect(() => {
    const timer = setInterval(() => void flush(), 15_000);
    const onReconnect = () => void flush();
    window.addEventListener("online", onReconnect);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", onReconnect);
    };
  }, [flush]);

  function submit() {
    if (response === null) return;
    setError(null);
    writeOutbox(
      mistakeId,
      queueEntry(readOutbox(mistakeId), {
        id: mistakeId,
        response,
        timeSpentSeconds: 0,
        queuedAt: Date.now(),
        attempts: 0,
        // Minted here, before the request leaves. This is what makes asking
        // again safe against a count the server increments.
        clientKey: crypto.randomUUID(),
      }),
    );
    void flush();
  }

  if (outcome) {
    // Shown only until the refresh lands. The page then renders the same
    // verdict from the stored retry.
    return (
      <div className="ui-retry" data-outcome={outcome.correct ? "correct" : "wrong"}>
        <p className="ui-retry-verdict" role="status">
          {outcome.correct ? "Right this time." : "Still not right."}
        </p>
        <p className="ui-retry-message">{outcome.message}</p>
      </div>
    );
  }

  return (
    <div className="ui-retry">
      <p className="ui-retry-prompt">Have another go before you see the answer.</p>

      {error && <p className="ui-retry-error">{error}</p>}

      {choiceType && (
        <>
          {multi && (
            <p className="ui-hint">More than one option may be right. Tick every one that is.</p>
          )}
          <ul className="ui-retry-options">
            {options!.map((option) => {
              const chosen = keys.includes(option.key);
              return (
                <li key={option.key}>
                  <button
                    type="button"
                    className="ui-retry-option"
                    aria-pressed={chosen}
                    data-chosen={chosen || undefined}
                    onClick={() => setKeys((current) => toggleKey(type, current, option.key))}
                  >
                    <span className="ui-retry-option-key">{option.key}</span>
                    <span>{option.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {booleanType && !choiceType && (
        <ul className="ui-retry-options">
          {[true, false].map((value) => (
            <li key={String(value)}>
              <button
                type="button"
                className="ui-retry-option"
                aria-pressed={bool === value}
                data-chosen={bool === value || undefined}
                onClick={() => setBool(value)}
              >
                <span className="ui-retry-option-key">{value ? "T" : "F"}</span>
                <span>{value ? "True" : "False"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!choiceType && !booleanType && (
        <label className="ui-retry-field">
          <span>Your answer</span>
          <input
            type="text"
            className="ui-input"
            // A decimal keypad for a number, and the raw text kept as typed so
            // "0.05" and "-0.5" can be entered at all.
            inputMode={numericType ? "decimal" : undefined}
            autoComplete="off"
            aria-invalid={unreadable || undefined}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {unreadable && (
            <span className="ui-hint">That is not a number yet.</span>
          )}
        </label>
      )}

      <div className="ui-retry-actions">
        <button
          type="button"
          className="ui-button"
          data-variant="primary"
          data-size="lg"
          disabled={!ready || unsent}
          onClick={submit}
        >
          <span>{unsent ? "Saved — sending…" : "Check my answer"}</span>
        </button>
      </div>

      {unsent && (
        /*
          The same three agreeing signals practice uses: the words, the dot,
          and the button. And the same honesty about what is NOT happening —
          the verdict is the server's, because the answer sits behind a check
          that they retried, and marking here would mean putting the key on
          the device.
        */
        <p className="ui-runner-unsent" role="status" data-offline={!online || undefined}>
          <span className="ui-runner-unsent-dot" aria-hidden="true" />
          {online
            ? "Saved on this device. Sending it now — your answer is not lost."
            : "Saved on this device. You are offline, so it will go up by itself when you are back — nothing is lost, and you will see how you did then."}
        </p>
      )}
    </div>
  );
}
