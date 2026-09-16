"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Add an endpoint, and show the secret once.
 *
 * ---------------------------------------------------------------------------
 * "Once" has to be true on the screen as well as in the database
 * ---------------------------------------------------------------------------
 * The secret is returned by exactly one response and no read path selects the
 * column, so there is nowhere else it can come from. That makes this panel the
 * only chance anybody gets, which is why it says so before it is dismissed
 * rather than after — and why the dismiss button is labelled with what it costs
 * ("I have copied it") rather than "Close".
 *
 * Losing it is not a disaster: rotating issues a new one. The screen says that
 * too, because a person who believes they have destroyed the integration will
 * delete it and start again, and starting again loses the delivery log.
 */

const EVENTS = [
  {
    value: "ASSESSMENT_PUBLISHED",
    wire: "assessment.published",
    title: "A paper is published",
  },
  {
    value: "RESULTS_RELEASED",
    wire: "results.released",
    title: "Results are released",
  },
  {
    value: "STUDENT_ENROLLED",
    wire: "student.enrolled",
    title: "A student joins a class",
  },
];

export function AddEndpoint() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  function toggle(value: string) {
    setEvents((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    );
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
      // The trailing slash matters: `trailingSlash: true` applies to route
      // handlers, and a POST to the unslashed path is 308'd — which drops the
      // body on the redirect.
      const response = await fetch("/api/institute/webhooks/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, label, events }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      setSecret(json.secret);
      setUrl("");
      setLabel("");
      setEvents([]);
      setOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="ui-wh-add">
      {secret && (
        <div className="ui-wh-secret" role="status">
          <h3 className="ui-wh-secret-title">
            Copy this signing secret now — it is not shown again
          </h3>
          <p className="ui-wh-secret-body">
            Your system uses it to check that a delivery really came from us.
            We keep it only to sign with, and there is no page that will show it
            to you a second time. If it is lost, rotate the endpoint for a new
            one; you do not need to delete anything.
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

      {!open ? (
        <button
          type="button"
          className="ui-button"
          data-variant="primary"
          onClick={() => setOpen(true)}
        >
          <span>Add an endpoint</span>
        </button>
      ) : (
        <div className="ui-wh-form">
          <label className="ui-field">
            <span>Name</span>
            <input
              className="ui-input"
              value={label}
              placeholder="Office server"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>

          <label className="ui-field">
            <span>Address</span>
            <input
              className="ui-input"
              value={url}
              inputMode="url"
              placeholder="https://mis.example.edu/hooks/sahayak"
              onChange={(event) => setUrl(event.target.value)}
            />
            <span className="ui-wh-hint">
              Must be https. Deliveries carry a class&rsquo;s marks.
            </span>
          </label>

          <fieldset className="ui-wh-fieldset">
            <legend>Send it</legend>
            {EVENTS.map((event) => (
              <label key={event.value} className="ui-wh-check">
                <input
                  type="checkbox"
                  checked={events.includes(event.value)}
                  onChange={() => toggle(event.value)}
                />
                <span>
                  {event.title}
                  <code className="ui-wh-code">{event.wire}</code>
                </span>
              </label>
            ))}
          </fieldset>

          {error && (
            <p className="ui-wh-error" role="alert">
              {error}
            </p>
          )}

          <div className="ui-wh-form-actions">
            <button
              type="button"
              className="ui-button"
              data-variant="primary"
              disabled={pending}
              onClick={submit}
            >
              <span>{pending ? "Adding…" : "Add endpoint"}</span>
            </button>
            <button
              type="button"
              className="ui-button"
              data-variant="ghost"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              <span>Cancel</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
