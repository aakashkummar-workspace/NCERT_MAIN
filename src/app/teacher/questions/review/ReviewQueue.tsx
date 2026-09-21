"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ComponentProps } from "react";
import type { QuestionDetail } from "@/core/questions";
import { Alert, Badge, Button, Card, EmptyState, Row } from "@/ui";
import { QuestionEditor } from "../QuestionEditor";
import { QuestionView } from "../QuestionView";

/**
 * The review queue: one draft at a time, read in full, then a decision.
 *
 * ---------------------------------------------------------------------------
 * Faster, never unread
 * ---------------------------------------------------------------------------
 * What takes a reviewer's time in the bank is not reading — it is finding the
 * next draft, opening it, and finding the buttons. So the queue removes that:
 * the next draft is already loaded, the decision is one key, and the queue moves
 * on by itself. What it does not remove is the reading. There is no "approve
 * all" and no multi-select; each approval is of one question somebody looked
 * at. An approval nobody read is a claim that is untrue.
 *
 * Keys: A approve · R reject · E edit · S or → skip · ← back. They are ignored
 * while typing in a field and while the editor is open.
 */

type Decision = "approved" | "rejected" | "skipped";
type EditorProps = ComponentProps<typeof QuestionEditor>;

const TYPE_LABEL: Record<string, string> = {
  MCQ: "Multiple choice",
  MULTI_SELECT: "Multi-select",
  TRUE_FALSE: "True / false",
  NUMERIC: "Numeric",
  FILL_BLANK: "Fill the blank",
  ASSERTION_REASON: "Assertion–reason",
  VSA: "Very short answer",
  SA: "Short answer",
  LA: "Long answer",
  CASE_STUDY: "Case study",
};

const title = (value: string) => value.charAt(0) + value.slice(1).toLowerCase();

export function ReviewQueue({
  initialItems,
  remaining,
  batchHref,
  skippedBefore,
  subjects,
  chapters,
  outcomes,
}: {
  initialItems: QuestionDetail[];
  /** Drafts matching the filters when this batch was loaded, this batch included. */
  remaining: number;
  /** This queue's address without `skip`; the next batch adds the ones skipped here. */
  batchHref: string;
  /** Drafts skipped in earlier batches, which the next batch starts after. */
  skippedBefore: number;
  subjects: EditorProps["subjects"];
  chapters: EditorProps["chapters"];
  outcomes: EditorProps["outcomes"];
}) {
  const [items, setItems] = useState(initialItems);
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState<false | "approve" | "reject">(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = items[index] ?? null;
  const counts = Object.values(decisions).reduce(
    (tally, decision) => ({ ...tally, [decision]: tally[decision] + 1 }),
    { approved: 0, rejected: 0, skipped: 0 } as Record<Decision, number>,
  );

  const advance = useCallback(() => {
    setError(null);
    setIndex((at) => Math.min(at + 1, items.length));
  }, [items.length]);

  const decide = useCallback(
    async (action: "approve" | "reject") => {
      if (!current || busy) return;
      let reason: string | undefined;
      if (action === "reject") {
        // A rejection with no reason is a dead end for whoever wrote it.
        const given = window.prompt(
          "Why is this being rejected?\n\nWhoever wrote it will see this, so say what would fix it.",
        );
        if (!given?.trim()) return;
        reason = given.trim();
      }
      setBusy(action);
      setError(null);
      try {
        const response = await fetch(`/api/questions/${current.id}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, reason }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          setError(payload?.error?.message ?? "That did not work. Nothing was changed.");
        } else {
          setDecisions((all) => ({ ...all, [current.id]: action === "approve" ? "approved" : "rejected" }));
          advance();
        }
      } catch {
        setError("We could not reach the server. Nothing was changed.");
      }
      setBusy(false);
    },
    [current, busy, advance],
  );

  const skip = useCallback(() => {
    if (!current) return;
    setDecisions((all) => (all[current.id] ? all : { ...all, [current.id]: "skipped" }));
    advance();
  }, [current, advance]);

  /** After an edit the question is a new version: read it back, as it now stands. */
  const reload = useCallback(async (id: string) => {
    const response = await fetch(`/api/questions/${id}/`);
    if (!response.ok) return;
    const fresh = (await response.json()) as QuestionDetail;
    setItems((all) => all.map((item) => (item.id === id ? fresh : item)));
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (editing || busy || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === "a" && current?.validation.approvable && !decisions[current.id]) {
        event.preventDefault();
        void decide("approve");
      } else if (key === "r" && current && !decisions[current.id]) {
        event.preventDefault();
        void decide("reject");
      } else if (key === "e" && current) {
        event.preventDefault();
        setEditing(true);
      } else if (key === "s" || event.key === "ArrowRight") {
        event.preventDefault();
        skip();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex((at) => Math.max(at - 1, 0));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, busy, current, decisions, decide, skip]);

  if (items.length === 0) {
    return (
      <EmptyState
        title="Nothing waiting for review"
        body="Every draft matching these filters has been approved, rejected or archived. Choose another subject or chapter above, or come back when new drafts arrive."
      />
    );
  }

  const progress = (
    <p className="ui-rq-progress" aria-live="polite">
      <span className="tabular">{Math.min(index + 1, items.length)}</span> of{" "}
      <span className="tabular">{items.length}</span> in this batch ·{" "}
      <span className="tabular">{remaining}</span> drafts matched when it loaded ·{" "}
      <strong className="tabular">{counts.approved}</strong> approved,{" "}
      <span className="tabular">{counts.rejected}</span> rejected,{" "}
      <span className="tabular">{counts.skipped}</span> skipped
    </p>
  );

  if (!current) {
    const more = remaining - counts.approved - counts.rejected - counts.skipped;
    return (
      <Stackish>
        {progress}
        <Card title="Batch done">
          <p style={{ margin: "0 0 14px" }}>
            {more > 0
              ? `About ${more} more ${more === 1 ? "draft is" : "drafts are"} waiting after this batch.`
              : "That was the last batch for these filters."}
            {counts.skipped > 0 && " Skipped drafts stay in the queue; they come round again later."}
          </p>
          <Row>
            {more > 0 && (
              <Link href={`${batchHref}${batchHref.includes("?") ? "&" : "?"}skip=${skippedBefore + counts.skipped}`} className="ui-button" data-variant="primary" data-size="md">
                <span>Next batch</span>
              </Link>
            )}
            <Button variant="ghost" onClick={() => setIndex(0)}>
              Back to the start of this batch
            </Button>
          </Row>
        </Card>
      </Stackish>
    );
  }

  if (editing) {
    return (
      <Stackish>
        {progress}
        <QuestionEditor
          initial={{ ...current, version: current.version }}
          subjects={subjects}
          chapters={chapters}
          outcomes={outcomes}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void reload(current.id);
          }}
        />
      </Stackish>
    );
  }

  const decided = decisions[current.id];
  const errors = current.validation.problems.filter((problem) => problem.severity === "error");
  const warnings = current.validation.problems.filter((problem) => problem.severity !== "error");

  return (
    <Stackish>
      {progress}
      <div className="ui-editor">
        <div className="ui-editor-main">
          {error && <Alert tone="danger">{error}</Alert>}
          {decided && decided !== "skipped" && (
            <Alert tone={decided === "approved" ? "success" : "warning"}>
              You {decided} this question. Press → to move on.
            </Alert>
          )}
          <Card>
            <QuestionView question={current} />
          </Card>
        </div>

        <div className="ui-editor-side">
          <Card title="This draft">
            <Row>
              <Badge tone="neutral">{TYPE_LABEL[current.type] ?? current.type}</Badge>
              <Badge tone="neutral">
                <span className="tabular">{current.marks}</span> {current.marks === 1 ? "mark" : "marks"}
              </Badge>
              <Badge tone="neutral">{title(current.difficulty)}</Badge>
            </Row>
            <dl className="ui-facts">
              <dt>Subject</dt>
              <dd>{current.subjectName}</dd>
              {current.chapterTitle && (
                <>
                  <dt>Chapter</dt>
                  <dd>
                    {current.chapterNumber ? `${current.chapterNumber}. ` : ""}
                    {current.chapterTitle}
                  </dd>
                </>
              )}
              <dt>Outcomes</dt>
              <dd>
                {current.outcomeIds.length === 0 ? (
                  <Badge tone="warning">None linked</Badge>
                ) : (
                  <span className="tabular">{current.outcomeIds.length}</span>
                )}
              </dd>
            </dl>
            <Link href={`/teacher/questions/${current.id}`} className="ui-hint" target="_blank">
              Open the full question page ↗
            </Link>
          </Card>

          {(errors.length > 0 || warnings.length > 0) && (
            <Card title="Checks">
              <ul className="ui-check-list">
                {[...errors, ...warnings].map((problem, at) => (
                  <li key={at} data-severity={problem.severity}>
                    <Badge tone={problem.severity === "error" ? "danger" : "warning"}>
                      {problem.severity === "error" ? "Must fix" : "Consider"}
                    </Badge>
                    <span>{problem.message}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="ui-editor-actions">
            <Button
              variant="primary"
              fullWidth
              disabled={!current.validation.approvable || busy !== false || Boolean(decided)}
              loading={busy === "approve"}
              loadingLabel="Approving…"
              onClick={() => void decide("approve")}
            >
              Approve <kbd className="ui-kbd">A</kbd>
            </Button>
            <Button
              variant="secondary"
              fullWidth
              disabled={busy !== false}
              onClick={() => setEditing(true)}
            >
              Edit <kbd className="ui-kbd">E</kbd>
            </Button>
            <Button
              variant="ghost"
              fullWidth
              disabled={busy !== false || Boolean(decided)}
              loading={busy === "reject"}
              loadingLabel="Rejecting…"
              onClick={() => void decide("reject")}
            >
              Reject <kbd className="ui-kbd">R</kbd>
            </Button>
            <Row>
              <Button variant="ghost" disabled={index === 0 || busy !== false} onClick={() => setIndex((at) => Math.max(at - 1, 0))}>
                ← Back
              </Button>
              <Button variant="ghost" disabled={busy !== false} onClick={skip}>
                Skip <kbd className="ui-kbd">S</kbd> →
              </Button>
            </Row>
            {!current.validation.approvable && (
              <p className="ui-hint">It cannot be approved until the checks above are cleared — edit it, or reject it with a reason.</p>
            )}
          </div>
        </div>
      </div>
    </Stackish>
  );
}

function Stackish({ children }: { children: React.ReactNode }) {
  return <div className="ui-rq">{children}</div>;
}
