"use client";

import { useState } from "react";
import { LEVEL_BLURB, LEVEL_LABEL, type Level } from "@/core/tutor/guard";

/**
 * The help ladder, on a question.
 *
 * ---------------------------------------------------------------------------
 * Why the button says what it will do
 * ---------------------------------------------------------------------------
 * Three rungs, each named for what the student is agreeing to see: a hint, then
 * the method, then the idea said another way. A single "Help" button would let
 * somebody who wanted a nudge land on a full walkthrough, which is the thing
 * this feature is most careful not to hand out — and having seen it, they
 * cannot go back to not having seen it.
 *
 * The panel starts closed and named for the smallest step, so the cheapest,
 * least revealing thing is the easy one to press.
 *
 * ---------------------------------------------------------------------------
 * It never says the answer, and it says so
 * ---------------------------------------------------------------------------
 * Stated once at the top rather than implied. A student who expects the answer
 * and does not get one concludes the feature is broken; a student told what it
 * is for uses it for that.
 */

type Turn = { level: Level; content: string; withheld: boolean };

export function AskForHelp({
  questionId,
  practiceAnswerId,
  studentMistakeId,
  initialTurns = [],
  initialCanEscalate = true,
  costsEvidence = false,
}: {
  questionId: string;
  practiceAnswerId?: string | null;
  studentMistakeId?: string | null;
  initialTurns?: Turn[];
  initialCanEscalate?: boolean;
  /**
   * Whether taking help here means this question stops counting as evidence.
   *
   * True inside practice, and said out loud. The rule is applied whether or not
   * the student is told, so not telling them would only mean finding out from a
   * progress figure that did not move — which reads as the product being
   * broken, or worse, as a punishment nobody mentioned.
   */
  costsEvidence?: boolean;
}) {
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [canEscalate, setCanEscalate] = useState(initialCanEscalate);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  // What the next press gives them. The server decides the real level; this is
  // the same ladder read forwards so the button can name it honestly.
  const next: Level =
    turns.length === 0 ? "HINT" : turns.length === 1 ? "STEPS" : "EXPLAIN";

  async function ask() {
    setPending(true);
    setError(null);
    try {
      const result = await fetch("/api/tutor/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId,
          practiceAnswerId: practiceAnswerId ?? null,
          studentMistakeId: studentMistakeId ?? null,
        }),
      });
      const json = await result.json().catch(() => null);
      if (!result.ok) {
        setError(json?.error?.message ?? "We could not get you help just now.");
        // A refusal that will repeat — the plan, the day's cap, nothing to
        // reach and nothing authored — takes the button with it. Left up, it
        // invites a student to press it until they conclude it is broken.
        if (json?.error?.details?.retryable === false) setExhausted(true);
        return;
      }
      setTurns((existing) => {
        // The server returns the last turn again when there is nothing further
        // to give, so an unchanged level is a repeat, not a new rung.
        const already = existing.some(
          (turn) => turn.level === json.level && turn.content === json.content,
        );
        return already
          ? existing
          : [
              ...existing,
              {
                level: json.level as Level,
                content: json.content as string,
                withheld: json.withheld === true,
              },
            ];
      });
      setCanEscalate(json.canEscalate === true);
    } catch {
      setError("We could not get you help just now. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="ui-help" aria-label="Help with this question">
      <p className="ui-help-note">
        This will not tell you the answer — it points you at how to get there.
        {costsEvidence && turns.length === 0 && !exhausted && (
          <>
            {" "}
            If you take it, this question stops counting towards your progress.
          </>
        )}
      </p>

      {turns.map((turn, index) => (
        <article className="ui-help-turn" key={`${turn.level}-${index}`}>
          <h3 className="ui-help-turn-head">{TURN_HEAD[turn.level]}</h3>
          <p className="ui-help-turn-body">{turn.content}</p>
        </article>
      ))}

      {error && <p className="ui-help-error">{error}</p>}

      {exhausted ? null : canEscalate ? (
        <div className="ui-help-actions">
          <button
            type="button"
            className="ui-button"
            data-variant={turns.length === 0 ? "secondary" : "ghost"}
            data-size="md"
            disabled={pending}
            onClick={() => void ask()}
          >
            <span>{pending ? "Thinking…" : LEVEL_LABEL[next]}</span>
          </button>
          <span className="ui-help-blurb">{LEVEL_BLURB[next]}</span>
        </div>
      ) : (
        <p className="ui-help-blurb">
          That is as far as I can take you without doing it for you. Have a go.
        </p>
      )}
    </section>
  );
}

/**
 * What each rung is called once it is on the page.
 *
 * Different words from the button, which is a promise about what pressing it
 * does. These are labels on what is already there.
 */
const TURN_HEAD: Record<Level, string> = {
  HINT: "A hint",
  STEPS: "The method",
  EXPLAIN: "Another way to look at it",
};
