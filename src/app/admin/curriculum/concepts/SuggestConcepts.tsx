"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Proposals, and a person deciding.
 *
 * The model drafts; nothing is written until somebody presses Accept on one
 * particular grouping. That is the same arrangement question generation uses,
 * and it matters more here: a concept changes what every school in the product
 * measures, and there is no undo that does not orphan evidence.
 *
 * Each draft shows the outcomes it would cover IN FULL rather than by code. The
 * reviewer's actual job is deciding whether these statements share an idea, and
 * that cannot be done from a list of identifiers.
 */

type Draft = {
  name: string;
  description: string;
  rationale: string;
  outcomes: { id: string; code: string; statement: string; chapterTitle: string }[];
  flags: string[];
};

/** Uncovered outcomes proposed for a concept that already exists. */
type LinkDraft = {
  conceptId: string;
  conceptName: string;
  rationale: string;
  outcomes: Draft["outcomes"];
  flags: string[];
};

export function SuggestConcepts({
  subjects,
}: {
  subjects: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [discarded, setDiscarded] = useState(0);
  const [accepted, setAccepted] = useState<Record<string, "done" | "busy">>({});

  async function draft() {
    setPending(true);
    setError(null);
    setDrafts(null);
    setLinks([]);
    setAccepted({});
    try {
      const response = await fetch("/api/admin/curriculum/concepts/suggest/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "draft", subjectId }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "We could not draft anything.");
        return;
      }
      setDrafts(json.drafts as Draft[]);
      setLinks((json.links ?? []) as LinkDraft[]);
      setDiscarded(json.discarded ?? 0);
    } catch {
      setError("We could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  async function accept(draftItem: Draft) {
    setAccepted((current) => ({ ...current, [draftItem.name]: "busy" }));
    setError(null);
    try {
      const response = await fetch("/api/admin/curriculum/concepts/suggest/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "accept",
          name: draftItem.name,
          description: draftItem.description,
          outcomeIds: draftItem.outcomes.map((outcome) => outcome.id),
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "We could not create that concept.");
        setAccepted((current) => {
          const next = { ...current };
          delete next[draftItem.name];
          return next;
        });
        return;
      }
      setAccepted((current) => ({ ...current, [draftItem.name]: "done" }));
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    }
  }

  /** Keyed by concept, so two links to one concept cannot share a button state. */
  const linkKey = (item: LinkDraft) => `link:${item.conceptId}:${item.outcomes.map((o) => o.id).join(",")}`;

  async function acceptLink(item: LinkDraft) {
    const key = linkKey(item);
    setAccepted((current) => ({ ...current, [key]: "busy" }));
    setError(null);
    try {
      const response = await fetch("/api/admin/curriculum/concepts/suggest/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "link",
          conceptId: item.conceptId,
          outcomeIds: item.outcomes.map((outcome) => outcome.id),
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.message ?? "We could not add those outcomes.");
        setAccepted((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        return;
      }
      setAccepted((current) => ({ ...current, [key]: "done" }));
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    }
  }

  if (subjects.length === 0) return null;

  return (
    <section className="ui-concept-new">
      <h2 className="ui-platform-heading">Draft concepts from uncovered outcomes</h2>
      <p className="ui-hint">
        Groups the outcomes nothing measures into the ideas they share. Nothing
        is created until you accept a grouping — read the statements, not just
        the name.
      </p>

      <div className="ui-concept-new-fields">
        <label className="ui-field">
          <span>Subject</span>
          <select
            className="ui-input"
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
          >
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ui-button"
          data-variant="secondary"
          data-size="md"
          disabled={pending || subjectId === ""}
          onClick={() => void draft()}
        >
          <span>{pending ? "Drafting…" : "Draft proposals"}</span>
        </button>
      </div>

      {error && <p className="ui-concept-error">{error}</p>}

      {drafts !== null && drafts.length === 0 && links.length === 0 && (
        <p className="ui-hint">
          Nothing proposed. That is a real answer: outcomes that share no idea
          are better left uncovered and visible than filed under a concept
          somebody has to unpick later.
        </p>
      )}

      {drafts !== null && discarded > 0 && (
        // Reported rather than swallowed. If most of a batch is being dropped,
        // the prompt is wrong and somebody should be able to see that.
        <p className="ui-hint">
          {discarded} {discarded === 1 ? "proposal was" : "proposals were"}{" "}
          discarded before you saw {discarded === 1 ? "it" : "them"} — a name
          that already exists, a concept or outcomes that were not on the list,
          or outcomes already proposed elsewhere.
        </p>
      )}

      {drafts !== null && drafts.length > 0 && (
        <ul className="ui-draft-list">
          {drafts.map((item) => (
            <li key={item.name} className="ui-draft">
              <div className="ui-draft-head">
                <div>
                  <h3 className="ui-draft-name">{item.name}</h3>
                  <p className="ui-draft-description">{item.description}</p>
                </div>
                <button
                  type="button"
                  className="ui-button"
                  data-variant={accepted[item.name] === "done" ? "ghost" : "primary"}
                  data-size="sm"
                  disabled={Boolean(accepted[item.name])}
                  onClick={() => void accept(item)}
                >
                  <span>
                    {accepted[item.name] === "done"
                      ? "Created"
                      : accepted[item.name] === "busy"
                        ? "Creating…"
                        : `Accept · ${item.outcomes.length}`}
                  </span>
                </button>
              </div>

              <p className="ui-draft-rationale">{item.rationale}</p>

              {item.flags.map((flag) => (
                // Advice, not a blocker. The reviewer decides.
                <p key={flag} className="ui-concept-warning">
                  {flag}
                </p>
              ))}

              {/*
                In full. The reviewer's job is judging whether these statements
                share an idea, and that cannot be done from a list of codes.
              */}
              <ul className="ui-draft-outcomes">
                {item.outcomes.map((outcome) => (
                  <li key={outcome.id}>
                    <span className="ui-uncovered-code tabular">{outcome.code}</span>
                    <span className="ui-uncovered-statement">
                      {outcome.statement}
                    </span>
                    <span className="ui-uncovered-where">{outcome.chapterTitle}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {links.length > 0 && (
        <>
          <h3 className="ui-platform-heading">Add to a concept that already exists</h3>
          <p className="ui-hint">
            These outcomes look like the same idea as a concept this subject already
            measures. Accepting adds them to it — and, like any edit, clears that
            concept&rsquo;s review.
          </p>
          <ul className="ui-draft-list">
            {links.map((item) => {
              const key = linkKey(item);
              return (
                <li key={key} className="ui-draft">
                  <div className="ui-draft-head">
                    <div>
                      <h3 className="ui-draft-name">{item.conceptName}</h3>
                      <p className="ui-draft-description">Existing concept</p>
                    </div>
                    <button
                      type="button"
                      className="ui-button"
                      data-variant={accepted[key] === "done" ? "ghost" : "primary"}
                      data-size="sm"
                      disabled={Boolean(accepted[key])}
                      onClick={() => void acceptLink(item)}
                    >
                      <span>
                        {accepted[key] === "done"
                          ? "Added"
                          : accepted[key] === "busy"
                            ? "Adding…"
                            : `Add · ${item.outcomes.length}`}
                      </span>
                    </button>
                  </div>
                  <p className="ui-draft-rationale">{item.rationale}</p>
                  {item.flags.map((flag) => (
                    <p key={flag} className="ui-concept-warning">
                      {flag}
                    </p>
                  ))}
                  <ul className="ui-draft-outcomes">
                    {item.outcomes.map((outcome) => (
                      <li key={outcome.id}>
                        <span className="ui-uncovered-code tabular">{outcome.code}</span>
                        <span className="ui-uncovered-statement">{outcome.statement}</span>
                        <span className="ui-uncovered-where">{outcome.chapterTitle}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
