"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Switch an endpoint off, or issue a new secret.
 *
 * Switching off is not a delete and the label says so — "Switch off", never
 * "Remove". The row survives because the delivery log survives with it, and
 * "did the marks ever reach the office" is the only question anybody asks about
 * an integration once something has gone wrong.
 *
 * Rotating shows the new secret here, once, for the same reason the create
 * panel does.
 */
export function EndpointActions({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  async function setActive(next: boolean) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/institute/webhooks/${id}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function rotate() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/institute/webhooks/${id}/rotate/`, {
        method: "POST",
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      setSecret(json.secret);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ui-button"
        data-variant="secondary"
        data-size="sm"
        disabled={pending}
        onClick={() => setActive(!active)}
      >
        <span>{active ? "Switch off" : "Switch on"}</span>
      </button>

      <button
        type="button"
        className="ui-button"
        data-variant="ghost"
        data-size="sm"
        disabled={pending}
        onClick={rotate}
      >
        <span>New secret</span>
      </button>

      {error && (
        <p className="ui-wh-error" role="alert">
          {error}
        </p>
      )}

      {secret && (
        <div className="ui-wh-secret" role="status">
          <h4 className="ui-wh-secret-title">
            The new secret — copy it now, it is not shown again
          </h4>
          <p className="ui-wh-secret-body">
            Paste it into the receiving system straight away. Until you do,
            deliveries will be signed with a key it does not have and it will
            reject them.
          </p>
          <code className="ui-wh-secret-value">{secret}</code>
          <button
            type="button"
            className="ui-button"
            data-variant="secondary"
            data-size="sm"
            onClick={() => setSecret(null)}
          >
            <span>I have copied it</span>
          </button>
        </div>
      )}
    </>
  );
}
