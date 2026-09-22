"use client";

import { useState } from "react";
import { Alert, Button, Field, Select } from "@/ui";

/**
 * Extra time and read-aloud for one student. Applied from their NEXT sitting:
 * a paper already under way keeps the clock it started with.
 */
export function AccommodationsForm({
  studentId,
  initial,
}: {
  studentId: string;
  initial: { extraTimePercent: number; readAloud: boolean };
}) {
  const [extra, setExtra] = useState(initial.extraTimePercent);
  const [readAloud, setReadAloud] = useState(initial.readAloud);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/students/${studentId}/accommodations/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraTimePercent: extra, readAloud }),
      });
      const payload = await response.json().catch(() => null);
      setMessage(
        response.ok
          ? { tone: "success", text: "Saved. It applies from their next paper." }
          : { tone: "danger", text: payload?.error?.message ?? "That did not save." },
      );
    } catch {
      setMessage({ tone: "danger", text: "We could not reach the server. Nothing was saved." });
    }
    setBusy(false);
  }

  return (
    <>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <Field label="Extra time on every paper" htmlFor="extra-time">
        <Select id="extra-time" value={extra} onChange={(event) => setExtra(Number(event.target.value))}>
          <option value={0}>None</option>
          <option value={25}>25% more</option>
          <option value={33}>33% more (20 minutes an hour)</option>
          <option value={50}>50% more</option>
        </Select>
      </Field>
      <label className="ui-outcome-choice" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={readAloud} onChange={(event) => setReadAloud(event.target.checked)} />
        <span>
          <strong>Questions read aloud.</strong> The test player offers to read each
          question and its options, on their own device.
        </span>
      </label>
      <div style={{ marginTop: 12 }}>
        <Button variant="primary" loading={busy} loadingLabel="Saving…" onClick={save}>
          Save
        </Button>
      </div>
    </>
  );
}
