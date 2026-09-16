"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card } from "@/ui";

export function AssignmentActions({
  assignmentId,
  status,
}: {
  assignmentId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    if (
      !window.confirm(
        "Cancel this assignment?\n\nStudents will no longer be able to sit it. Anything already submitted is kept.",
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assignments/${assignmentId}/`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "That did not work.");
      } else {
        router.refresh();
      }
    } catch {
      setError("We could not reach the server. Nothing was changed.");
    }
    setBusy(false);
  }

  if (status === "CANCELLED") {
    return (
      <Alert tone="info" title="Cancelled">
        Nobody can sit this. To run it again, assign the paper to the class
        afresh with a new window.
      </Alert>
    );
  }

  return (
    <Card title="Actions">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="ui-editor-actions">
        <Button
          variant="ghost"
          fullWidth
          onClick={cancel}
          loading={busy}
          loadingLabel="Cancelling…"
        >
          Cancel this assignment
        </Button>
      </div>
      <p className="ui-hint" style={{ marginTop: 10 }}>
        {status === "OPEN"
          ? "The window is open. Cancelling stops anyone starting, and keeps anything already submitted."
          : "Editing the window arrives alongside live progress."}
      </p>
    </Card>
  );
}
