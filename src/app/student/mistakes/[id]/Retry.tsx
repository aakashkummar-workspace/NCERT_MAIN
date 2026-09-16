"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  buildResponse,
  isMultiSelect,
  parseNumber,
  toggleKey,
} from "@/core/attempts/response";

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
 */

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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RetryOutcome | null>(null);

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

  async function submit() {
    if (response === null) return;
    setPending(true);
    setError(null);
    try {
      const result = await fetch(`/api/student/mistakes/${mistakeId}/retry/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      const json = await result.json().catch(() => null);
      if (!result.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      setOutcome(json as RetryOutcome);
      // The page comes back revealed, and carries the verdict itself from the
      // stored retry — so the result stays on screen after this component has
      // gone, and on any later visit.
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
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
          disabled={!ready || pending}
          onClick={() => void submit()}
        >
          <span>{pending ? "Checking…" : "Check my answer"}</span>
        </button>
      </div>
    </div>
  );
}
