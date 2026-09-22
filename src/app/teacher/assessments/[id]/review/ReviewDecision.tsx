"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, Field, Textarea } from "@/ui";

/** Approve, or send back with a note. A note is required to send it back. */
export function ReviewDecision({ assessmentId }: { assessmentId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "changes" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: "approve" | "changes") {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/assessments/${assessmentId}/review/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: note.trim() || null }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "That did not save.");
        setBusy(null);
        return;
      }
      router.push("/teacher/assessments");
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was decided.");
      setBusy(null);
    }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <Card title="Your decision">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field
          label="Note for the author"
          htmlFor="review-note"
          hint="Required to send it back. Say which question and what to change."
        >
          <Textarea
            id="review-note"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <div className="ui-row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <Button
            variant="primary"
            loading={busy === "approve"}
            loadingLabel="Approving…"
            disabled={busy !== null}
            onClick={() => decide("approve")}
          >
            Approve for publishing
          </Button>
          <Button
            variant="secondary"
            loading={busy === "changes"}
            loadingLabel="Sending back…"
            disabled={busy !== null || note.trim() === ""}
            onClick={() => decide("changes")}
          >
            Ask for changes
          </Button>
        </div>
      </Card>
    </div>
  );
}
