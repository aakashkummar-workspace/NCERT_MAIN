"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Start, or resume.
 *
 * The idempotency key is generated on the device BEFORE the request leaves it.
 * That is what makes a double tap on a slow connection produce one sitting
 * instead of two — the server recognises the key and hands back the attempt it
 * already created. A key generated server-side would be a new key every time,
 * which is exactly the bug.
 */
export function StartTest({
  assignmentId,
  canStart,
  resuming,
  inProgressAttemptId,
}: {
  assignmentId: string;
  canStart: boolean;
  resuming: boolean;
  inProgressAttemptId: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An unfinished sitting can be reopened directly; there is nothing to create.
  if (resuming && inProgressAttemptId) {
    return (
      <button
        type="button"
        className="ui-button"
        data-variant="primary"
        data-size="lg"
        onClick={() => router.push(`/student/attempt/${inProgressAttemptId}`)}
      >
        <span>Resume test</span>
      </button>
    );
  }

  if (!canStart) {
    return (
      <button type="button" className="ui-button" data-variant="secondary" data-size="lg" disabled>
        <span>Not open yet</span>
      </button>
    );
  }

  async function start() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/attempts/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignmentId,
          clientAttemptId: crypto.randomUUID(),
        }),
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body?.error?.message ?? "We could not start the test.");
        setPending(false);
        return;
      }

      router.push(`/student/attempt/${body.attemptId}`);
    } catch {
      setError(
        "We could not reach the server. Check your connection and try again.",
      );
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ui-button"
        data-variant="primary"
        data-size="lg"
        disabled={pending}
        onClick={() => void start()}
      >
        <span>{pending ? "Starting…" : "Start test"}</span>
      </button>
      {error && (
        <p className="ui-error" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </p>
      )}
    </>
  );
}
