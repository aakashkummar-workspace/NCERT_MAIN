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
  assignedPracticeId,
  label,
}: {
  conceptId: string;
  questionCount: number;
  /** Set when a teacher asked for this one, so the set records the homework. */
  assignedPracticeId?: string;
  label?: string;
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
          assignedPracticeId,
          // The source says who decided. "A teacher asked" and "the product
          // suggested" are different sessions, and only one of them measures
          // whether the recommendations are any good.
          source: assignedPracticeId ? "ASSIGNED" : "RECOMMENDED",
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
        <span>{pending ? "Opening…" : (label ?? "Start")}</span>
      </button>
    </div>
  );
}
