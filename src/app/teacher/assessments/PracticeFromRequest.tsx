"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Button, Card, Field, Input, Textarea } from "@/ui";

type ProposedSet = {
  conceptId: string;
  conceptName: string;
  chapterTitle: string;
  available: number;
  problem: string | null;
  alreadySet: boolean;
};

type Proposal = {
  classId: string;
  className: string;
  questionCount: number;
  dueOn: string | null;
  studentNote: string | null;
  note: string | null;
  adjustments: string[];
  sets: ProposedSet[];
};

/** Mirrors MIN_SET and MAX_SET in core/practice/recommend — a client cannot import them. */
const MIN_SET = 4;
const MAX_SET = 10;

/**
 * Practice from a sentence.
 *
 * The model reads the sentence into a class, ideas, a count and a day
 * (core/practice/from-request.ts). Nothing is set by that: assigned practice
 * has no draft state, so the proposal is shown here and the teacher presses
 * Set, which posts each ticked set to the ordinary class route — the one the
 * class page's own form uses, with its refusals and its audit row.
 */
export function PracticeFromRequest() {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [count, setCount] = useState(MIN_SET);
  const [dueOn, setDueOn] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});

  async function propose() {
    setBusy(true);
    setError(null);
    setProposal(null);
    setOutcomes({});
    try {
      const response = await fetch("/api/practice/from-request/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "That did not work. Nothing was set.");
      } else {
        const next = payload as Proposal;
        setProposal(next);
        setCount(next.questionCount);
        setDueOn(next.dueOn ?? "");
        setNote(next.studentNote ?? "");
        // Ready ones ticked; one the class already has open is left for the
        // teacher to decide.
        setTicked(
          new Set(
            next.sets
              .filter((row) => row.available >= next.questionCount && !row.alreadySet)
              .map((row) => row.conceptId),
          ),
        );
      }
    } catch {
      setError("We could not reach the server. Nothing was set.");
    }
    setBusy(false);
  }

  function toggle(conceptId: string, on: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(conceptId);
      else next.delete(conceptId);
      return next;
    });
  }

  const validCount = Number.isInteger(count) && count >= MIN_SET && count <= MAX_SET;
  const ready = (row: ProposedSet) => row.available >= count;
  const chosen = proposal
    ? proposal.sets.filter((row) => ticked.has(row.conceptId) && ready(row) && !outcomes[row.conceptId])
    : [];

  async function setAll() {
    if (!proposal || saving) return;
    setSaving(true);
    // One at a time, through the class page's own route, so each set is
    // refused or accepted exactly as it would be by hand.
    for (const row of chosen) {
      let message: string;
      try {
        const response = await fetch(`/api/classes/${proposal.classId}/practice/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conceptId: row.conceptId,
            questionCount: count,
            dueOn: dueOn || undefined,
            note: note.trim() || undefined,
          }),
        });
        const json = await response.json().catch(() => null);
        message = response.ok ? "set" : (json?.error?.message ?? "That did not save.");
      } catch {
        message = "We could not reach the server. This one was not set.";
      }
      setOutcomes((current) => ({ ...current, [row.conceptId]: message }));
    }
    setSaving(false);
  }

  const setCountDone = proposal ? proposal.sets.filter((row) => outcomes[row.conceptId] === "set").length : 0;

  return (
    <Card
      title="Describe practice"
      description="Say which class, which idea or chapter, and by when. You see the sets first — nothing reaches students until you press Set."
    >
      <Field
        label="What should the class practise?"
        htmlFor="practice-request"
        hint="For example: “10-A needs practice on similar triangles, 8 questions, by Friday”"
      >
        <Textarea
          id="practice-request"
          rows={2}
          maxLength={600}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
        />
      </Field>
      <div className="ui-paper-ask-actions">
        <Button
          variant="secondary"
          loading={busy}
          loadingLabel="Working it out…"
          disabled={request.trim().length < 8}
          onClick={() => void propose()}
        >
          Suggest practice
        </Button>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {proposal && (
        <div className="ui-paper-ask-result">
          <p className="ui-paper-ask-title">
            <strong>Practice for {proposal.className}</strong> · one set per idea · not set yet
          </p>
          {proposal.note && <p className="ui-hint">Check: {proposal.note}</p>}
          {proposal.adjustments.length > 0 && (
            <Alert tone="info" title="Changed from what you asked">
              <ul>
                {proposal.adjustments.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Alert>
          )}

          <ul className="ui-practice-ask-list">
            {proposal.sets.map((row) => {
              const outcome = outcomes[row.conceptId];
              const canSet = ready(row) && !outcome;
              const id = `practice-ask-${row.conceptId}`;
              return (
                <li key={row.conceptId}>
                  <label className="ui-outcome-choice" htmlFor={id}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={canSet && ticked.has(row.conceptId)}
                      disabled={!canSet || saving}
                      onChange={(event) => toggle(row.conceptId, event.target.checked)}
                    />
                    <span>
                      <strong>{row.conceptName}</strong>
                      <span className="ui-hint">
                        {" "}
                        · {row.chapterTitle} · {row.available} practice{" "}
                        {row.available === 1 ? "question" : "questions"} in your bank
                      </span>
                      {outcome === "set" ? (
                        <>
                          {" "}
                          <Badge tone="success">Set</Badge>
                        </>
                      ) : outcome ? (
                        <span className="ui-error"> {outcome}</span>
                      ) : !ready(row) ? (
                        <span className="ui-hint">
                          {" "}
                          — the bank has {row.available} and you asked for {count}. Lower the count, or
                          approve more questions on it.
                        </span>
                      ) : row.alreadySet ? (
                        <span className="ui-hint"> — {proposal.className} already has open practice on this.</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          <div className="ui-setpractice-row">
            <Field label="Questions in each set" htmlFor="practice-ask-count">
              <Input
                id="practice-ask-count"
                type="number"
                inputMode="numeric"
                min={MIN_SET}
                max={MAX_SET}
                value={count}
                invalid={!validCount}
                onChange={(event) => setCount(Number(event.target.value))}
              />
            </Field>
            <Field label="By (optional)" htmlFor="practice-ask-due">
              <Input
                id="practice-ask-due"
                type="date"
                value={dueOn}
                onChange={(event) => setDueOn(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Note for students (optional)" htmlFor="practice-ask-note">
            <Input
              id="practice-ask-note"
              type="text"
              maxLength={200}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>

          <p className="ui-hint">
            Practice is not a test. There is no timer, no marks and nothing to release — students get the
            answer and the explanation after each question, and a late one still counts.
          </p>

          <div className="ui-paper-ask-actions">
            <Button
              variant="primary"
              disabled={chosen.length === 0 || !validCount}
              loading={saving}
              loadingLabel="Setting"
              onClick={() => void setAll()}
            >
              {chosen.length === 0
                ? "Nothing ticked to set"
                : `Set ${chosen.length} for ${proposal.className}`}
            </Button>
            {setCountDone > 0 && (
              <Link
                href={`/teacher/classes/${proposal.classId}/#set-practice`}
                className="ui-button"
                data-variant="secondary"
                data-size="md"
              >
                <span>See it on {proposal.className}&rsquo;s page</span>
              </Link>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
