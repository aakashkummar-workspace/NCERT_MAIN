"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The Copilot conversation.
 *
 * ---------------------------------------------------------------------------
 * Not a chat window
 * ---------------------------------------------------------------------------
 * It looks like one and behaves like one, but the two things that make a chat
 * window feel cheap are deliberately absent: there is no typing indicator
 * pretending to be thinking, and no infinite scroll of the model's own
 * enthusiasm. Every answer carries the figures it used, and a teacher who wants
 * to check one can.
 *
 * Each turn costs a DEEP-tier call, which is roughly forty times a
 * classification. The suggested questions exist partly so a teacher's first one
 * is a good one, and partly so it is not four.
 */

export type Turn = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  citations: string[];
  actions: { label: string; rationale: string }[];
};

const SUGGESTIONS = [
  "What should I reteach next week, and to which class?",
  "Which students are behind in more than one topic?",
  "Has anything I have already tried actually worked?",
  "Which class is furthest behind, and is it the same topic as the others?",
];

export function Copilot({
  blocked = null,
  conversationId,
  initialTurns,
}: {
  /** Why the plan will refuse, known before anything is offered. */
  blocked?: string | null;
  conversationId: string | null;
  initialTurns: Turn[];
}) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState(conversationId);

  async function send(text: string) {
    const asked = text.trim();
    if (asked.length < 3 || pending) return;

    setPending(true);
    setError(null);
    // Their own question goes up immediately. A teacher who has pressed send
    // and sees nothing presses send again, which on this tier is a real cost.
    setTurns((current) => [
      ...current,
      { id: `pending-${Date.now()}`, role: "USER", content: asked, citations: [], actions: [] },
    ]);
    setQuestion("");

    try {
      const response = await fetch("/api/copilot/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: asked, conversationId: id ?? undefined }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong. Try again.");
        // The question comes back into the box rather than being lost.
        setTurns((current) => current.filter((turn) => !turn.id.startsWith("pending-")));
        setQuestion(asked);
        return;
      }

      setId(json.conversationId);
      setTurns((current) => [
        ...current.filter((turn) => !turn.id.startsWith("pending-")),
        { id: `u-${Date.now()}`, role: "USER", content: asked, citations: [], actions: [] },
        {
          id: `a-${Date.now()}`,
          role: "ASSISTANT",
          content: json.answer,
          citations: json.citations ?? [],
          actions: json.suggestedActions ?? [],
        },
      ]);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="ui-copilot">
      {turns.length === 0 ? (
        <div className="ui-copilot-empty">
          <p>
            Ask about your classes. It reads your marked work, the gaps it has
            found, and what you have already tried — and it will tell you when
            there is not enough marked to answer.
          </p>
          {blocked ? (
            <p className="ui-hint" role="status">
              {blocked} <Link href="/teacher/settings">See what your plan includes</Link>.
            </p>
          ) : (
          <ul className="ui-copilot-suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void send(suggestion)}
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
          )}
        </div>
      ) : (
        <ol className="ui-copilot-turns">
          {turns.map((turn) => (
            <li key={turn.id} className="ui-copilot-turn" data-role={turn.role}>
              {turn.role === "USER" ? (
                <p className="ui-copilot-question">{turn.content}</p>
              ) : (
                <div className="ui-copilot-answer">
                  <p className="ui-copilot-text">{turn.content}</p>

                  {/*
                    The figures it used, quoted. A teacher acting on this across
                    a whole cohort has to be able to find the row it came from —
                    otherwise it is an assertion with a robot's confidence.
                  */}
                  {turn.citations.length > 0 && (
                    <details className="ui-copilot-citations">
                      <summary>What this is based on</summary>
                      <ul>
                        {turn.citations.map((citation) => (
                          <li key={citation}>{citation}</li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {turn.actions.length > 0 && (
                    <ul className="ui-copilot-actions">
                      {turn.actions.map((action) => (
                        <li key={action.label}>
                          <strong>{action.label}</strong>
                          <span>{action.rationale}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
          {pending && (
            <li className="ui-copilot-turn" data-role="ASSISTANT">
              {/*
                Says what it is doing, not "thinking…". This one reads a whole
                cohort and takes a few seconds; a teacher told what is happening
                waits, and one shown a bouncing dot presses send again.
              */}
              <p className="ui-copilot-working">
                Reading your classes and the marked work…
              </p>
            </li>
          )}
        </ol>
      )}

      {error && <p className="ui-copilot-error">{error}</p>}

      <form
        className="ui-copilot-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send(question);
        }}
      >
        <textarea
          className="ui-textarea"
          rows={2}
          maxLength={1000}
          value={question}
          disabled={pending || Boolean(blocked)}
          placeholder="Ask about a class, a topic, or a student…"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(question);
            }
          }}
        />
        <button
          type="submit"
          className="ui-button"
          data-variant="primary"
          disabled={question.trim().length < 3 || pending || Boolean(blocked)}
        >
          <span>{pending ? "Asking…" : "Ask"}</span>
        </button>
      </form>

      <p className="ui-hint">
        {/*
          Said out loud. This is the most expensive thing in the product per
          call, and a teacher who knows that treats it as a tool rather than a
          toy — which is also how they get value from it.
        */}
        Each question reads your whole cohort, so it takes a few seconds and
        counts against your monthly allowance. It answers only from your own
        marked work — if there is not enough, it says so rather than guessing.{" "}
        <Link href="/teacher/settings">See what your plan includes</Link>.
      </p>
    </div>
  );
}
