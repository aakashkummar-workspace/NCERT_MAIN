"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * One organisation's plan. Changing it asks first, because it changes what
 * every teacher and student in that school can do the moment it is saved.
 */
export function PlanPicker({
  organizationId,
  organizationName,
  current,
  isFallback,
  plans,
}: {
  organizationId: string;
  organizationName: string;
  current: string;
  isFallback: boolean;
  plans: { code: string; name: string }[];
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(current);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const changed = choice !== current;
  const choiceName = plans.find((plan) => plan.code === choice)?.name ?? choice;

  async function save() {
    if (!window.confirm(`Put ${organizationName} on the ${choiceName} plan? It applies straight away.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/organizations/${organizationId}/plan/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planCode: choice }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "That did not save.");
      } else {
        setMessage(`Now on ${json.planName}.`);
        router.refresh();
      }
    } catch {
      setError("We could not reach the server. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ui-org-plan">
      <label className="sr-only" htmlFor={`plan-${organizationId}`}>
        Plan for {organizationName}
      </label>
      <select
        id={`plan-${organizationId}`}
        className="ui-select"
        value={choice}
        disabled={busy}
        onChange={(event) => {
          setChoice(event.target.value);
          setMessage(null);
        }}
      >
        {plans.map((plan) => (
          <option key={plan.code} value={plan.code}>
            {plan.name}
            {plan.code === current && isFallback ? " (no plan chosen)" : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="ui-button"
        data-variant={changed ? "primary" : "secondary"}
        disabled={!changed || busy}
        onClick={() => void save()}
      >
        <span>{busy ? "Saving…" : "Save plan"}</span>
      </button>
      {message && (
        <span className="ui-org-plan-note" role="status">
          {message}
        </span>
      )}
      {error && (
        <span className="ui-org-plan-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
