"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Open a set.
 *
 * A single button rather than a form: everything about the set — which concept,
 * how many, which questions — was decided by the recommendation the student is
 * looking at. Asking them to configure it here would be asking them to re-make
 * a decision the product just explained to them.
 */
export function StartPractice({
  conceptId,
  questionCount,
}: {
  conceptId: string;
  questionCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/practice/sessions/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conceptId,
          source: "RECOMMENDED",
          questionCount,
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      router.push(`/student/practice/${json.sessionId}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="ui-practice-set-action">
      {error && <p className="ui-practice-error">{error}</p>}
      <button
        type="button"
        className="ui-button"
        data-variant="primary"
        data-size="lg"
        disabled={pending}
        onClick={() => void start()}
      >
        <span>{pending ? "Opening…" : "Start"}</span>
      </button>
    </div>
  );
}
