"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Button, Card, Field, Textarea } from "@/ui";

type Built = {
  assessmentId: string;
  classId: string;
  className: string;
  title: string;
  summary: string[];
  note: string | null;
  adjustments: string[];
  shortfalls: string[];
  window: { opensAt: string; closesAt: string } | null;
};

const EXAMPLES = [
  "20-mark MCQ test on Triangles for 10-A, due Friday",
  "Board pattern practice paper for 10-A, whole syllabus",
  "Easy revision test on Real Numbers and Polynomials, 30 minutes",
];

/**
 * A paper from a sentence.
 *
 * The model reads the sentence into a plan; the builder fills it from approved
 * bank questions by rule and saves a DRAFT (core/assessments/from-request.ts).
 * Nothing is published or assigned here — the teacher opens the draft, reads
 * it, and sends it, exactly as with a paper built by hand. The screen says so
 * before and after, because "the AI set my class a test" is the one thing this
 * must never be mistaken for.
 */
export function PaperFromRequest() {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);

  async function draft() {
    setBusy(true);
    setError(null);
    setBuilt(null);
    try {
      const response = await fetch("/api/assessments/from-request/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "That did not work. Nothing was saved.");
      } else {
        setBuilt(payload as Built);
      }
    } catch {
      setError("We could not reach the server. Nothing was saved.");
    }
    setBusy(false);
  }

  // The window travels to the assign panel as a suggestion, never applied.
  const openHref = built
    ? `/teacher/assessments/${built.assessmentId}/?class=${built.classId}${
        built.window
          ? `&opens=${encodeURIComponent(built.window.opensAt)}&closes=${encodeURIComponent(built.window.closesAt)}`
          : ""
      }`
    : "";

  return (
    <Card
      title="Describe a paper"
      description="Say which class, which chapters and how long. A draft is built from questions you have already approved — nothing is sent to students until you open it, check it and assign it."
    >
      <Field label="What paper do you want?" htmlFor="paper-request" hint={`For example: “${EXAMPLES[0]}”`}>
        <Textarea
          id="paper-request"
          rows={3}
          maxLength={600}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder={EXAMPLES[1]}
        />
      </Field>
      <div className="ui-paper-ask-actions">
        <Button
          variant="primary"
          loading={busy}
          loadingLabel="Building the draft…"
          disabled={request.trim().length < 8}
          onClick={() => void draft()}
        >
          Draft the paper
        </Button>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {built && (
        <div className="ui-paper-ask-result" role="status">
          <p className="ui-paper-ask-title">
            <strong>{built.title}</strong> · for {built.className} · saved as a draft
          </p>
          <ul>
            {built.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {built.note && <p className="ui-hint">Check: {built.note}</p>}
          {built.adjustments.length > 0 && (
            <Alert tone="info" title="Changed to fit your bank">
              <ul>
                {built.adjustments.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Alert>
          )}
          {built.shortfalls.length > 0 && (
            <Alert tone="warning" title="The bank could not fill all of it">
              <ul>
                {built.shortfalls.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p>
                The draft holds what the bank had.{" "}
                <Link href="/teacher/questions/generate/">Generate more drafts</Link> to approve, or
                change the paper by hand.
              </p>
            </Alert>
          )}
          <div className="ui-paper-ask-actions">
            <Link href={openHref} className="ui-button" data-variant="primary" data-size="md">
              <span>Open the draft to check and assign</span>
            </Link>
          </div>
        </div>
      )}
    </Card>
  );
}
