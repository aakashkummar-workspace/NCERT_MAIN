"use client";

import { useState } from "react";
import { Alert, Button, Field, Input } from "@/ui";

/** One student's APAAR ID. Twelve digits, or empty to clear it. */
export function ApaarForm({ studentId, initial }: { studentId: string; initial: string | null }) {
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/students/${studentId}/apaar/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apaarId: value.trim() === "" ? null : value }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        setValue(payload?.apaarId ?? "");
        setMessage({ tone: "success", text: value.trim() === "" ? "Cleared." : "Saved. It appears in marks exports." });
      } else {
        setMessage({ tone: "danger", text: payload?.error?.message ?? "That did not save." });
      }
    } catch {
      setMessage({ tone: "danger", text: "We could not reach the server. Nothing was saved." });
    }
    setBusy(false);
  }

  return (
    <>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <Field label="APAAR ID" htmlFor="apaar-id" hint="12 digits, as on the student's APAAR card. Spaces are fine.">
        <Input
          id="apaar-id"
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <div style={{ marginTop: 12 }}>
        <Button variant="primary" loading={busy} loadingLabel="Saving…" onClick={save}>
          Save
        </Button>
      </div>
    </>
  );
}
