"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Button, Card, Select } from "@/ui";

/**
 * One chapter's review, in the order a subject teacher would check it: what the
 * chapter asks students to do, which ideas those outcomes group into, then
 * whether each question is filed under the right one.
 *
 * Every approval is one press on one item, and says what it approves. There is
 * no "approve all" — see core/curriculum/review.ts for why.
 *
 * Approvals update the row in place rather than refreshing the page: a chapter
 * holds sixty-odd questions, and reloading all of them after every tag would
 * throw the reviewer back to the top of the list.
 */

type Outcome = {
  id: string;
  code: string;
  statement: string;
  bloomLevel: string;
  topicTitle: string;
  reviewedAt: string | null;
};

type Concept = {
  id: string;
  name: string;
  description: string | null;
  outcomeCodes: string[];
  requires: string[];
  reviewedAt: string | null;
};

type Question = {
  id: string;
  stem: string;
  options: { key: string; text: string; isCorrect: boolean }[];
  explanation: string | null;
  difficulty: string;
  provenance: string | null;
  outcomeId: string | null;
  tagReviewedAt: string | null;
};

const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

async function post(body: unknown): Promise<{ ok: true; changed?: boolean } | { ok: false; message: string }> {
  try {
    const response = await fetch("/api/admin/review/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, message: json?.error?.message ?? "That did not save." };
    return { ok: true, changed: json?.changed };
  } catch {
    return { ok: false, message: "We could not reach the server. Nothing was saved." };
  }
}

export function ChapterReview({
  chapterId,
  outcomes: initialOutcomes,
  concepts: initialConcepts,
  questions: initialQuestions,
  librarySource,
}: {
  chapterId: string;
  outcomes: Outcome[];
  concepts: Concept[];
  questions: Question[];
  librarySource: boolean;
}) {
  const [outcomes, setOutcomes] = useState(initialOutcomes);
  const [concepts, setConcepts] = useState(initialConcepts);
  const [questions, setQuestions] = useState(initialQuestions);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(true);

  const now = () => new Date().toISOString();
  const outcomeLabel = new Map(outcomes.map((o) => [o.id, `${o.code} — ${o.statement}`]));

  async function approveOutcome(id: string) {
    setBusy(id);
    setError(null);
    const result = await post({ action: "approve-outcome", id });
    if (result.ok) setOutcomes((rows) => rows.map((o) => (o.id === id ? { ...o, reviewedAt: now() } : o)));
    else setError(result.message);
    setBusy(null);
  }

  async function approveConcept(id: string) {
    setBusy(id);
    setError(null);
    const result = await post({ action: "approve-concept", id });
    if (result.ok) setConcepts((rows) => rows.map((c) => (c.id === id ? { ...c, reviewedAt: now() } : c)));
    else setError(result.message);
    setBusy(null);
  }

  async function confirmTag(question: Question) {
    const outcomeId = choice[question.id] ?? question.outcomeId;
    if (!outcomeId) return;
    setBusy(question.id);
    setError(null);
    const result = await post({ action: "confirm-tag", id: question.id, outcomeId });
    if (result.ok) {
      setQuestions((rows) =>
        rows.map((q) => (q.id === question.id ? { ...q, outcomeId, tagReviewedAt: now() } : q)),
      );
    } else {
      setError(result.message);
    }
    setBusy(null);
  }

  const reviewedOutcomes = outcomes.filter((o) => o.reviewedAt).length;
  const reviewedConcepts = concepts.filter((c) => c.reviewedAt).length;
  const reviewedTags = questions.filter((q) => q.tagReviewedAt).length;
  const shownQuestions = onlyUnreviewed ? questions.filter((q) => !q.tagReviewedAt) : questions;

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}

      <Card
        title={`1. Learning outcomes — ${reviewedOutcomes} of ${outcomes.length} reviewed`}
        description="Is each one something this chapter really asks a student to do, worded so a question could be written from the sentence alone? To change the wording, edit it in the curriculum editor — an edit sends it back here."
        action={
          <Link href={`/admin/curriculum/chapter/${chapterId}`} className="ui-button" data-variant="secondary" data-size="sm">
            <span>Edit outcomes</span>
          </Link>
        }
      >
        {outcomes.length === 0 ? (
          <p className="ui-hint">This chapter has no learning outcomes yet.</p>
        ) : (
          <ul className="ui-cr-list">
            {outcomes.map((o) => (
              <li key={o.id} data-reviewed={o.reviewedAt ? true : undefined}>
                <div className="ui-cr-body">
                  <div className="ui-cr-meta">
                    <span className="tabular">{o.code}</span>
                    <span>{o.topicTitle}</span>
                    <span>{o.bloomLevel.toLowerCase()}</span>
                  </div>
                  <p className="ui-cr-text">{o.statement}</p>
                </div>
                <div className="ui-cr-action">
                  {o.reviewedAt ? (
                    <Badge tone="success">Reviewed {date(o.reviewedAt)}</Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => approveOutcome(o.id)}
                      loading={busy === o.id}
                      loadingLabel="Saving"
                      aria-label={`Approve outcome ${o.code}`}
                    >
                      Approve
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={`2. Concepts — ${reviewedConcepts} of ${concepts.length} reviewed`}
        description="Do these outcomes share one idea a teacher would reteach together, and does the idea really rest on what it requires? Regroup or rename in the concept editor — a change sends it back here."
      >
        {concepts.length === 0 ? (
          <p className="ui-hint">No concept measures an outcome in this chapter.</p>
        ) : (
          <ul className="ui-cr-list">
            {concepts.map((c) => (
              <li key={c.id} data-reviewed={c.reviewedAt ? true : undefined}>
                <div className="ui-cr-body">
                  <p className="ui-cr-text">
                    <Link href={`/admin/curriculum/concepts/${c.id}`}>{c.name}</Link>
                  </p>
                  <div className="ui-cr-meta">
                    <span>Measured by {c.outcomeCodes.join(", ")}</span>
                    <span>{c.requires.length > 0 ? `Requires ${c.requires.join("; ")}` : "No prerequisites"}</span>
                  </div>
                </div>
                <div className="ui-cr-action">
                  {c.reviewedAt ? (
                    <Badge tone="success">Reviewed {date(c.reviewedAt)}</Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => approveConcept(c.id)}
                      loading={busy === c.id}
                      loadingLabel="Saving"
                      aria-label={`Approve concept ${c.name}`}
                    >
                      Approve
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={`3. Question tags — ${reviewedTags} of ${questions.length} reviewed`}
        description="Does each question really test the outcome it is filed under? Its evidence reaches a concept only through that tag. Pick a different outcome if it is wrong, then confirm."
        action={
          questions.length > 0 ? (
            <label className="ui-cr-toggle">
              <input
                type="checkbox"
                checked={onlyUnreviewed}
                onChange={(event) => setOnlyUnreviewed(event.target.checked)}
              />
              <span>Only unreviewed</span>
            </label>
          ) : undefined
        }
      >
        {!librarySource ? (
          <p className="ui-hint">No question library is configured, so there are no tags to review.</p>
        ) : questions.length === 0 ? (
          <p className="ui-hint">No library question is filed under this chapter.</p>
        ) : shownQuestions.length === 0 ? (
          <p className="ui-hint">Every question tag in this chapter has been reviewed.</p>
        ) : (
          <ol className="ui-cr-questions">
            {shownQuestions.map((q) => {
              const selected = choice[q.id] ?? q.outcomeId ?? "";
              const moving = Boolean(q.outcomeId) && selected !== q.outcomeId;
              return (
                <li key={q.id} data-reviewed={q.tagReviewedAt ? true : undefined}>
                  <p className="ui-cr-text">{q.stem}</p>
                  {q.options.length > 0 && (
                    <ul className="ui-cr-options">
                      {q.options.map((option) => (
                        <li key={option.key} data-correct={option.isCorrect || undefined}>
                          <span className="tabular">{option.key}.</span> {option.text}
                          {option.isCorrect && <Badge tone="success">Correct</Badge>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="ui-cr-meta">
                    <span>{q.difficulty.toLowerCase()}</span>
                    {q.provenance === "NCERT_EXEMPLAR" && <span>NCERT Exemplar</span>}
                    {!q.outcomeId && <Badge tone="warning">Not tagged</Badge>}
                  </div>
                  <div className="ui-cr-tag">
                    <Select
                      aria-label="Outcome this question tests"
                      value={selected}
                      onChange={(event) => setChoice((current) => ({ ...current, [q.id]: event.target.value }))}
                    >
                      {!q.outcomeId && <option value="">Choose an outcome…</option>}
                      {outcomes.map((o) => (
                        <option key={o.id} value={o.id}>
                          {outcomeLabel.get(o.id)}
                        </option>
                      ))}
                    </Select>
                    {q.tagReviewedAt && !moving ? (
                      <Badge tone="success">Reviewed {date(q.tagReviewedAt)}</Badge>
                    ) : (
                      <Button
                        variant={moving ? "primary" : "secondary"}
                        size="sm"
                        disabled={!selected}
                        onClick={() => confirmTag(q)}
                        loading={busy === q.id}
                        loadingLabel="Saving"
                      >
                        {moving ? "Move and confirm" : "Confirm tag"}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </>
  );
}
