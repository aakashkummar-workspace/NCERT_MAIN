"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/ui";

/**
 * "Papers are checked before they are published" — the school's switch for
 * head-of-department review. Saved the moment it changes, and said so.
 */
export function PaperReviewToggle({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/paper-review/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ required: next }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "That did not save.");
      } else {
        setOn(next);
        router.refresh();
      }
    } catch {
      setError("We could not reach the server. Nothing changed.");
    }
    setBusy(false);
  }

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <label className="ui-outcome-choice">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(event) => void change(event.target.checked)}
        />
        <span>
          <strong>Papers are checked before they are published.</strong> A teacher
          sends a finished paper to an owner or admin, who approves it or asks for
          changes. Nobody reviews their own paper, and editing a paper after it
          was approved sends it back for review.
        </span>
      </label>
    </>
  );
}
