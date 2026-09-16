"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, TrashIcon } from "@/ui";
import { formatDate } from "@/i18n/format";

/**
 * Setting practice for a class, on the class page.
 *
 * What a teacher chooses is one idea, how many questions, and a day. There is
 * no marks field and no pass mark, because this is practice: it is untimed,
 * the student gets feedback after every question, and the evidence it produces
 * carries practice's reduced weight. The card says so out loud, so nobody sets
 * one expecting a test and then looks for the results.
 *
 * The list under the form shows COUNTS — how many have done it, of how many
 * enrolled — and never a score. There is nothing else here a teacher can act
 * on, and a column of marks is the one thing this feature must not grow.
 */

/** Mirrors MIN_SET and MAX_SET in core/practice/recommend — a client cannot import them. */
const MIN_SET = 4;
const MAX_SET = 10;

export type PracticeSetRow = {
  id: string;
  conceptName: string;
  questionCount: number;
  dueAt: Date | null;
  note: string | null;
  cancelledAt: Date | null;
  done: number;
  started: number;
  expected: number;
};

export function SetPractice({
  classId,
  className,
  concepts,
  sets,
}: {
  classId: string;
  className: string;
  concepts: { conceptId: string; conceptName: string }[];
  sets: PracticeSetRow[];
}) {
  const router = useRouter();
  const [conceptId, setConceptId] = useState("");
  const [count, setCount] = useState(MIN_SET);
  const [dueOn, setDueOn] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = sets.filter((row) => row.cancelledAt === null);

  async function set() {
    if (!conceptId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/classes/${classId}/practice/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conceptId,
          questionCount: count,
          dueOn: dueOn || undefined,
          note: note.trim() || undefined,
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        // A thin bank names its own number, so this message is worth showing
        // as it stands rather than replacing with something general.
        setError(json?.error?.message ?? "That did not save. Try again.");
        return;
      }
      setConceptId("");
      setNote("");
      setDueOn("");
      router.refresh();
    } catch {
      setError("We could not reach the server. Your choices are still here — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function withdraw(row: PracticeSetRow) {
    if (
      !window.confirm(
        `Withdraw the practice on ${row.conceptName}?\n\nIt stops appearing for students who have not done it. Anything already practised stays — nothing is taken back.`,
      )
    ) {
      return;
    }
    setWithdrawing(row.id);
    setError(null);
    try {
      const response = await fetch(`/api/classes/${classId}/practice/`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedPracticeId: row.id }),
      });
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        setError(json?.error?.message ?? "That did not withdraw. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setWithdrawing(null);
    }
  }

  return (
    <Card
      title="Set practice"
      description="One idea, a handful of questions, untimed. Students see it on their home page and in their study plan."
    >
      {concepts.length === 0 ? (
        <p className="ui-ann-empty">
          Nothing to set yet. Practice is set on a concept, and no concept has
          been authored for {className}&rsquo;s subject — so there is nothing
          here to ask for. A platform admin adds them on the curriculum console.
        </p>
      ) : (
        <div className="ui-setpractice-form">
          <div className="ui-field">
            <label className="ui-label" htmlFor="practice-concept">
              Idea
            </label>
            <select
              id="practice-concept"
              className="ui-select"
              value={conceptId}
              onChange={(event) => setConceptId(event.target.value)}
            >
              <option value="">Choose an idea…</option>
              {concepts.map((concept) => (
                <option key={concept.conceptId} value={concept.conceptId}>
                  {concept.conceptName}
                </option>
              ))}
            </select>
          </div>

          <div className="ui-setpractice-row">
            <div className="ui-field">
              <label className="ui-label" htmlFor="practice-count">
                Questions
              </label>
              <input
                id="practice-count"
                className="ui-input"
                type="number"
                inputMode="numeric"
                min={MIN_SET}
                max={MAX_SET}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              />
            </div>
            <div className="ui-field">
              <label className="ui-label" htmlFor="practice-due">
                By (optional)
              </label>
              <input
                id="practice-due"
                className="ui-input"
                type="date"
                value={dueOn}
                onChange={(event) => setDueOn(event.target.value)}
              />
            </div>
          </div>

          <div className="ui-field">
            <label className="ui-label" htmlFor="practice-note">
              Note (optional)
            </label>
            <input
              id="practice-note"
              className="ui-input"
              type="text"
              maxLength={200}
              value={note}
              placeholder="For example: before Thursday's lesson."
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <p className="ui-hint">
            {/* Said before they press, not discovered afterwards: a teacher who
                sets this expecting marks will go looking for results that were
                never going to exist. */}
            Practice is not a test. There is no timer, no marks and nothing to
            release — students get the answer and the explanation after each
            question, and a late one still counts.
          </p>

          <div className="ui-setpractice-foot">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void set()}
              disabled={!conceptId}
              loading={saving}
              loadingLabel="Setting"
            >
              Set for {className}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="ui-error" role="alert">
          {error}
        </p>
      )}

      {open.length > 0 && (
        <ul className="ui-setpractice-list">
          {open.map((row) => (
            <li key={row.id} className="ui-setpractice-item">
              <div>
                <p className="ui-setpractice-title">{row.conceptName}</p>
                <p className="ui-setpractice-meta tabular">
                  {row.questionCount} questions
                  {row.dueAt ? ` · by ${formatDate("en-IN", row.dueAt)}` : ""}
                  {" · "}
                  {/* Counts, never a score. "8 of 30 have done it" is the only
                      thing there is to act on. */}
                  {row.done} of {row.expected} done
                  {row.started > row.done ? `, ${row.started - row.done} part way` : ""}
                </p>
                {row.note && <p className="ui-setpractice-note">{row.note}</p>}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void withdraw(row)}
                loading={withdrawing === row.id}
                loadingLabel="Withdrawing"
                aria-label={`Withdraw the practice on ${row.conceptName}`}
              >
                <TrashIcon size={14} />
                <span>Withdraw</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
