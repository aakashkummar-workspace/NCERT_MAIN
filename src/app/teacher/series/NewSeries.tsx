"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input } from "@/ui";

/**
 * Naming a series.
 *
 * Two fields and a note, because a series IS two fields: what the school calls
 * the event and which year it belongs to. There is no schedule here — the
 * dates come from the papers' own windows, and a second copy of them would be
 * a second copy that drifts.
 */
export function NewSeries({
  academicYear,
  label = "Name a series",
}: {
  academicYear: string;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [year, setYear] = useState(academicYear);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (name.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/series/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          academicYear: year,
          note: note.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        // A duplicate name says which year already has one. Worth showing as
        // it stands rather than replacing with something general.
        setError(payload?.error?.message ?? "That did not save.");
        setBusy(false);
        return;
      }
      router.push(`/teacher/series/${payload.id}`);
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was created.");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="ui-new-series">
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="ui-editor-row">
        <Field label="Name" htmlFor="ns-name">
          <Input
            id="ns-name"
            value={name}
            maxLength={80}
            placeholder="Half-Yearly"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Academic year" htmlFor="ns-year">
          <Input
            id="ns-year"
            value={year}
            placeholder="2026-27"
            onChange={(event) => setYear(event.target.value)}
          />
        </Field>
      </div>

      <Field label="Note (optional)" htmlFor="ns-note">
        <Input
          id="ns-note"
          value={note}
          maxLength={200}
          placeholder="For example: all Class 10 subjects, first week of October."
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      <p className="ui-hint">
        {/* Said before they press, because a series LOOKS like a report card
            and the first question is always what it scores. */}
        A series groups papers you have already set, or are about to. It carries
        no marks of its own and no total — each paper keeps its own window,
        marking and release, and the report lists them under this name.
      </p>

      <div className="ui-editor-actions">
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void create()}
          disabled={name.trim().length === 0}
          loading={busy}
          loadingLabel="Saving"
        >
          Create
        </Button>
      </div>
    </div>
  );
}
