"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Linking a concept to what measures it, and to what it rests on.
 *
 * Both halves of this screen change what every school in the product measures,
 * so both say what they will do before they do it. The prerequisite half is the
 * one to be careful with: it feeds root-cause analysis, which tells a teacher
 * to go and reteach something, and a wrong edge there costs a lesson.
 */

type Outcome = {
  id: string;
  code: string;
  statement: string;
  weight: number;
  subjectName: string;
  chapterTitle: string;
};

type Candidate = {
  id: string;
  code: string;
  statement: string;
  subjectName: string;
  chapterTitle: string;
};

type Prerequisite = { id: string; name: string; strength: number };

export function ConceptEditor({
  conceptId,
  outcomes,
  candidates,
  prerequisites,
  requiredBy,
  otherConcepts,
  chainWarning,
}: {
  conceptId: string;
  outcomes: Outcome[];
  candidates: Candidate[];
  prerequisites: Prerequisite[];
  requiredBy: { id: string; name: string }[];
  otherConcepts: { id: string; name: string }[];
  chainWarning: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [weight, setWeight] = useState("1");
  const [prereq, setPrereq] = useState("");

  async function send(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "That did not work.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("We could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/admin/curriculum/concepts/${conceptId}`;

  return (
    <>
      {error && <p className="ui-concept-error">{error}</p>}

      <section>
        <h2 className="ui-platform-heading">Measured through</h2>
        <p className="ui-hint" style={{ marginBottom: 12 }}>
          Every answer to a question filed under one of these outcomes becomes
          evidence about this concept. Weight is 1 for the idea a question is
          written to test and less for one it touches in passing.
        </p>

        {outcomes.length === 0 ? (
          <p className="ui-concept-warning">
            Nothing yet, so nothing can be measured through this concept.
          </p>
        ) : (
          <ul className="ui-concept-links">
            {outcomes.map((outcome) => (
              <li key={outcome.id}>
                <span className="ui-uncovered-code tabular">{outcome.code}</span>
                <span className="ui-uncovered-statement">{outcome.statement}</span>
                <span className="ui-uncovered-where">
                  {outcome.subjectName} · {outcome.chapterTitle} · weight{" "}
                  {outcome.weight}
                </span>
                <button
                  type="button"
                  className="ui-button"
                  data-variant="ghost"
                  data-size="sm"
                  disabled={busy}
                  onClick={() =>
                    void send(`${base}/outcomes/?outcomeId=${outcome.id}`, "DELETE")
                  }
                >
                  <span>Unlink</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/*
          Said out loud, because it is the question anybody hesitates over
          before pressing Unlink — and the answer is the reason this product
          keeps an append-only ledger at all.
        */}
        <p className="ui-hint" style={{ marginTop: 10 }}>
          Unlinking stops FUTURE answers counting. Everything already measured
          keeps its meaning, because each piece of evidence records the concept
          it was about.
        </p>

        <div className="ui-concept-add">
          <label className="ui-field">
            <span>Link an outcome</span>
            <select
              className="ui-input"
              value={pick}
              onChange={(event) => setPick(event.target.value)}
            >
              <option value="">Choose an outcome…</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.code} — {candidate.subjectName}: {candidate.statement.slice(0, 70)}
                </option>
              ))}
            </select>
          </label>
          <label className="ui-field" style={{ maxWidth: 120 }}>
            <span>Weight</span>
            <input
              type="number"
              className="ui-input"
              min="0.1"
              max="1"
              step="0.1"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="ui-button"
            data-variant="secondary"
            data-size="md"
            disabled={busy || pick === ""}
            onClick={() =>
              void send(`${base}/outcomes/`, "POST", {
                outcomeId: pick,
                weight: Number(weight),
              }).then((done) => {
                if (done) setPick("");
              })
            }
          >
            <span>Link</span>
          </button>
        </div>
      </section>

      <section>
        <h2 className="ui-platform-heading">Rests on</h2>
        <p className="ui-hint" style={{ marginBottom: 12 }}>
          What a student needs first. This is what lets a learning gap name a
          root cause instead of just a symptom — and it is only ever named when
          the class is weak on the prerequisite too.
        </p>

        {chainWarning && (
          <p className="ui-concept-warning">
            This chain runs deep. Root-cause analysis walks it, and a very long
            chain always lands on something from three years ago — true, and no
            use to a teacher deciding what to reteach on Thursday.
          </p>
        )}

        {prerequisites.length === 0 ? (
          <p className="ui-hint">Nothing yet.</p>
        ) : (
          <ul className="ui-concept-links">
            {prerequisites.map((prerequisite) => (
              <li key={prerequisite.id}>
                <span className="ui-uncovered-statement">{prerequisite.name}</span>
                <span className="ui-uncovered-where">
                  strength {prerequisite.strength}
                </span>
                <button
                  type="button"
                  className="ui-button"
                  data-variant="ghost"
                  data-size="sm"
                  disabled={busy}
                  onClick={() =>
                    void send(
                      `${base}/prerequisites/?prerequisiteId=${prerequisite.id}`,
                      "DELETE",
                    )
                  }
                >
                  <span>Remove</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="ui-concept-add">
          <label className="ui-field">
            <span>Add a prerequisite</span>
            <select
              className="ui-input"
              value={prereq}
              onChange={(event) => setPrereq(event.target.value)}
            >
              <option value="">Choose a concept…</option>
              {otherConcepts.map((concept) => (
                <option key={concept.id} value={concept.id}>
                  {concept.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ui-button"
            data-variant="secondary"
            data-size="md"
            disabled={busy || prereq === ""}
            onClick={() =>
              void send(`${base}/prerequisites/`, "POST", {
                prerequisiteId: prereq,
              }).then((done) => {
                if (done) setPrereq("");
              })
            }
          >
            <span>Add</span>
          </button>
        </div>
      </section>

      {requiredBy.length > 0 && (
        <section>
          {/*
            Named, because unlinking an outcome here weakens every concept that
            leans on this one — and nothing else on the screen would say so.
          */}
          <h2 className="ui-platform-heading">Depended on by</h2>
          <p className="ui-hint">
            {requiredBy.map((concept) => concept.name).join(", ")} —{" "}
            {requiredBy.length === 1 ? "this concept rests" : "these concepts rest"}{" "}
            on this one, so changing what it measures changes what they explain.
          </p>
        </section>
      )}
    </>
  );
}
