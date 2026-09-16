"use client";

import { useState } from "react";

/**
 * "Save for later" — a student's private bookmark on one question.
 *
 * Optimistic: the button flips the moment it is pressed and flips back if the
 * server refuses. A bookmark is not worth a spinner, and a student tapping it
 * on a slow connection should not wonder whether it took.
 *
 * `aria-pressed` carries the state, and the label says it in words as well —
 * a toggle whose only change is a colour is a toggle nobody can read.
 */
export function SaveQuestion({
  questionId,
  initiallySaved,
}: {
  questionId: string;
  initiallySaved: boolean;
}) {
  const [saved, setSaved] = useState(initiallySaved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    const next = !saved;
    setSaved(next);
    setPending(true);
    setError(null);
    try {
      const response = next
        ? await fetch("/api/saved/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionId }),
          })
        : await fetch(`/api/saved/${questionId}/`, { method: "DELETE" });
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        setSaved(!next);
        setError(json?.error?.message ?? "That did not save. Try again.");
      }
    } catch {
      setSaved(!next);
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="ui-saved-toggle">
      <button
        type="button"
        className="ui-button"
        data-variant={saved ? "secondary" : "ghost"}
        data-size="sm"
        aria-pressed={saved}
        data-saved={saved || undefined}
        onClick={() => void toggle()}
      >
        <span aria-hidden="true">{saved ? "★" : "☆"}</span>
        <span>{saved ? "Saved" : "Save for later"}</span>
      </button>
      {error && (
        <span className="ui-saved-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
