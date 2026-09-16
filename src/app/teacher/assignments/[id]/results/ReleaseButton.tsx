"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Release results to the class.
 *
 * The confirmation names what is about to happen in the numbers the teacher
 * cares about — how many papers still have marking outstanding — rather than
 * asking "are you sure?". Slice 7 already shows those students "marked so far"
 * with the marks still owed named, so releasing early is a legitimate choice
 * and not a trap; the dialog says so instead of blocking it.
 */
export function ReleaseButton({
  assignmentId,
  releasedAt,
  policy,
  awaitingMarking,
}: {
  assignmentId: string;
  releasedAt: string | null;
  policy: string;
  awaitingMarking: number;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (releasedAt) {
    return (
      <span className="ui-released">
        Released{" "}
        {new Date(releasedAt).toLocaleString("en-IN", {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </span>
    );
  }

  // Under the other two policies the clock does this, and a button that
  // duplicates a rule already running would only invite a teacher to wonder
  // which one won.
  if (policy !== "MANUAL") return null;

  async function release() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/assignments/${assignmentId}/release/`,
        { method: "POST" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error?.message ?? "We could not release the results.");
        setPending(false);
        return;
      }
      setAsking(false);
      router.refresh();
    } catch {
      setError("We could not reach the server. Try again.");
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ui-button"
        data-variant="primary"
        onClick={() => setAsking(true)}
      >
        <span>Release results</span>
      </button>

      {asking && (
        <div className="ui-confirm-backdrop" role="presentation">
          <div
            className="ui-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="release-title"
            aria-describedby="release-body"
          >
            <h2 id="release-title" className="ui-confirm-title">
              Release results to the class?
            </h2>
            <p id="release-body" className="ui-confirm-body">
              {awaitingMarking > 0 ? (
                <>
                  {awaitingMarking}{" "}
                  {awaitingMarking === 1 ? "paper still has" : "papers still have"}{" "}
                  written answers to mark. Those students will see their score so
                  far and how many marks are still with you — not a zero. You can
                  keep marking afterwards and their score will follow.
                </>
              ) : (
                <>Every paper is marked. Students will see their result the next time they open the app.</>
              )}
            </p>
            {error && (
              <p className="ui-error" role="alert">
                <span aria-hidden="true">⚠</span>
                <span>{error}</span>
              </p>
            )}
            <div className="ui-confirm-actions">
              <button
                type="button"
                className="ui-button"
                data-variant="secondary"
                onClick={() => setAsking(false)}
                autoFocus
              >
                <span>Not yet</span>
              </button>
              <button
                type="button"
                className="ui-button"
                data-variant="primary"
                disabled={pending}
                onClick={() => void release()}
              >
                <span>{pending ? "Releasing…" : "Release"}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
