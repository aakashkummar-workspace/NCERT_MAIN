"use client";

import { useState } from "react";
import { Alert, Button, Input, Select } from "@/ui";

type Domain = { key: string; label: string };
type Latest = Record<string, { level: string; note: string | null }>;

/**
 * Observations beyond marks. Each save is a new round — the old ones stay,
 * because a report already handed over quotes them.
 */
export function HolisticForm({
  studentId,
  domains,
  levels,
  latest,
}: {
  studentId: string;
  domains: Domain[];
  levels: string[];
  latest: Latest;
}) {
  const [values, setValues] = useState<Latest>(latest);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save() {
    const entries = domains.flatMap((domain) => {
      const value = values[domain.key];
      return value?.level ? [{ domain: domain.key, level: value.level, note: value.note || null }] : [];
    });
    if (entries.length === 0) {
      setMessage({ tone: "danger", text: "Choose a level for at least one area." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/students/${studentId}/holistic/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const payload = await response.json().catch(() => null);
      setMessage(
        response.ok
          ? { tone: "success", text: "Saved. The next term report will include it." }
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
      <div className="ui-holistic-form">
        {domains.map((domain) => {
          const value = values[domain.key] ?? { level: "", note: null };
          return (
            <div key={domain.key} className="ui-holistic-row">
              <span className="ui-holistic-label">{domain.label}</span>
              <Select
                aria-label={`${domain.label}: level`}
                value={value.level}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [domain.key]: { level: event.target.value, note: value.note } }))
                }
              >
                <option value="">Not observed</option>
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={`${domain.label}: what you saw`}
                placeholder="What you saw, in a sentence (optional)"
                maxLength={400}
                value={value.note ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [domain.key]: { level: value.level, note: event.target.value } }))
                }
              />
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12 }}>
        <Button variant="primary" loading={busy} loadingLabel="Saving…" onClick={save}>
          Save observations
        </Button>
      </div>
    </>
  );
}
