"use client";

import { useState } from "react";
import { Alert } from "@/ui";

/**
 * The parent's own switch for a weekly WhatsApp summary about this child.
 * Only the phone's owner can turn it on — WhatsApp's rules and ours.
 */
export function WhatsappDigestToggle({
  studentUserId,
  firstName,
  initial,
}: {
  studentUserId: string;
  firstName: string;
  initial: boolean;
}) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/parent/children/${studentUserId}/whatsapp/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: next }),
      });
      if (response.ok) setOn(next);
      else setError("That did not save. Try again.");
    } catch {
      setError("We could not reach the server. Nothing changed.");
    }
    setBusy(false);
  }

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <label className="ui-outcome-choice">
        <input type="checkbox" checked={on} disabled={busy} onChange={(event) => void change(event.target.checked)} />
        <span>
          <strong>Send me a weekly summary on WhatsApp.</strong> Only in weeks when{" "}
          {firstName} has a new released result — the marks, and one idea worth
          practising. Never their answers. Turn it off here, or reply STOP.
        </span>
      </label>
    </>
  );
}
