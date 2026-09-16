"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  checkOutcomeStatement,
  type OutcomeQuality,
} from "@/core/curriculum/outcome-quality";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select } from "@/ui";

type Quality = OutcomeQuality;

type Outcome = {
  id: string;
  code: string;
  statement: string;
  bloomLevel: string;
  competency: string;
  typicalMarks: number;
  concepts: { id: string; name: string }[];
  quality: Quality;
};

type Topic = { id: string; title: string; outcomes: Outcome[] };

const BLOOM = [
  "REMEMBER",
  "UNDERSTAND",
  "APPLY",
  "ANALYSE",
  "EVALUATE",
  "CREATE",
] as const;

const COMPETENCY = [
  "KNOWLEDGE",
  "UNDERSTANDING",
  "APPLICATION",
  "PROBLEM_SOLVING",
  "ANALYSIS",
  "EVALUATION",
] as const;

const label = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");

/**
 * The authoring surface.
 *
 * The statement box is the important control on this screen, so it is the
 * largest one and it carries live feedback. Everything else — code, Bloom
 * level, marks — is a small field beside it, because getting those wrong costs
 * a filter; getting the statement wrong costs every question generated from it.
 */
export function ChapterEditor({
  chapterId,
  topics,
}: {
  chapterId: string;
  topics: Topic[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingTopic, setAddingTopic] = useState(topics.length === 0);
  const [topicTitle, setTopicTitle] = useState("");
  const [composingIn, setComposingIn] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // A topic is renamed in place. The title is what a teacher sees in the
  // question filters, so a typo in it is not cosmetic — and deleting a topic to
  // fix one takes its outcomes with it.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");

  async function send(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "That did not save. Nothing was changed.");
        return null;
      }
      router.refresh();
      return payload;
    } catch {
      setError("We could not reach the server. Nothing was changed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createTopic() {
    const result = await send("/api/admin/curriculum/topics/", "POST", {
      chapterId,
      title: topicTitle,
    });
    if (result) {
      setTopicTitle("");
      setAddingTopic(false);
      setComposingIn(result.id);
    }
  }

  async function removeTopic(topic: Topic) {
    const warning =
      topic.outcomes.length > 0
        ? `Delete “${topic.title}”?\n\nIts ${topic.outcomes.length} learning ${
            topic.outcomes.length === 1 ? "outcome goes" : "outcomes go"
          } with it. Every organisation reads this curriculum.`
        : `Delete “${topic.title}”?`;
    if (!window.confirm(warning)) return;
    await send(`/api/admin/curriculum/topics/${topic.id}/`, "DELETE");
  }

  async function removeOutcome(outcome: Outcome) {
    if (
      !window.confirm(
        `Delete outcome ${outcome.code}?\n\nQuestions point at outcomes by code, so anything already written against it loses its grounding.`,
      )
    ) {
      return;
    }
    await send(`/api/admin/curriculum/outcomes/${outcome.id}/`, "DELETE");
  }

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}

      {topics.length === 0 && !addingTopic && (
        <EmptyState
          icon="◰"
          title="This chapter has no topics yet"
          body="A topic groups a handful of learning outcomes — the specific things a student can do. Start with the first section of the chapter."
          actions={
            <Button variant="primary" onClick={() => setAddingTopic(true)}>
              Add the first topic
            </Button>
          }
        />
      )}

      {topics.map((topic) => (
        <Card
          key={topic.id}
          title={topic.title}
          description={
            topic.outcomes.length === 0
              ? "No outcomes yet — nothing can be generated against this topic."
              : `${topic.outcomes.length} ${topic.outcomes.length === 1 ? "outcome" : "outcomes"}`
          }
          action={
            <span className="ui-row">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRenaming(topic.id);
                  setRenameTitle(topic.title);
                }}
                disabled={busy}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeTopic(topic)}
                disabled={busy}
              >
                Delete topic
              </Button>
            </span>
          }
        >
          {renaming === topic.id && (
            <div className="ui-outcome-form" style={{ marginBottom: 14 }}>
              <Field label="Topic name" htmlFor={`rename-${topic.id}`}>
                <Input
                  id={`rename-${topic.id}`}
                  value={renameTitle}
                  onChange={(event) => setRenameTitle(event.target.value)}
                  autoFocus
                />
              </Field>
              <div className="ui-row" style={{ marginTop: 14 }}>
                <Button
                  variant="primary"
                  loading={busy}
                  loadingLabel="Saving…"
                  disabled={
                    renameTitle.trim().length < 2 || renameTitle.trim() === topic.title
                  }
                  onClick={async () => {
                    const saved = await send(
                      `/api/admin/curriculum/topics/${topic.id}/`,
                      "PATCH",
                      { title: renameTitle },
                    );
                    if (saved) setRenaming(null);
                  }}
                >
                  Save name
                </Button>
                <Button variant="ghost" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {topic.outcomes.length > 0 && (
            <ul className="ui-outcome-list">
              {topic.outcomes.map((outcome) =>
                editing === outcome.id ? (
                  <li key={outcome.id}>
                    <OutcomeForm
                      initial={outcome}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSubmit={async (values) => {
                        const saved = await send(
                          `/api/admin/curriculum/outcomes/${outcome.id}/`,
                          "PATCH",
                          values,
                        );
                        if (saved) setEditing(null);
                      }}
                    />
                  </li>
                ) : (
                  <li key={outcome.id} className="ui-outcome">
                    <div className="ui-outcome-head">
                      <code className="ui-outcome-code">{outcome.code}</code>
                      <Badge tone="neutral">{label(outcome.bloomLevel)}</Badge>
                      <Badge tone="neutral">{label(outcome.competency)}</Badge>
                      <span className="ui-outcome-marks tabular">
                        {outcome.typicalMarks}{" "}
                        {outcome.typicalMarks === 1 ? "mark" : "marks"}
                      </span>
                      <span className="ui-outcome-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(outcome.id)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeOutcome(outcome)}
                          disabled={busy}
                        >
                          Delete
                        </Button>
                      </span>
                    </div>
                    <p className="ui-outcome-statement">{outcome.statement}</p>
                    {!outcome.quality.ok && (
                      <p className="ui-outcome-warning">
                        <span aria-hidden="true">⚠</span> {outcome.quality.reason}
                      </p>
                    )}
                    {outcome.concepts.length > 0 && (
                      <p className="ui-outcome-concepts">
                        Measured as:{" "}
                        {outcome.concepts.map((c) => c.name).join(", ")}
                      </p>
                    )}
                  </li>
                ),
              )}
            </ul>
          )}

          {composingIn === topic.id ? (
            <OutcomeForm
              busy={busy}
              onCancel={() => setComposingIn(null)}
              onSubmit={async (values) => {
                const saved = await send("/api/admin/curriculum/outcomes/", "POST", {
                  ...values,
                  topicId: topic.id,
                });
                if (saved) setComposingIn(null);
              }}
            />
          ) : (
            <div style={{ marginTop: 14 }}>
              <Button variant="secondary" onClick={() => setComposingIn(topic.id)}>
                Add a learning outcome
              </Button>
            </div>
          )}
        </Card>
      ))}

      {addingTopic ? (
        <Card title="New topic">
          <Field
            label="Topic name"
            htmlFor="topicTitle"
            hint="A section of the chapter. Two to five topics per chapter is usual."
          >
            <Input
              id="topicTitle"
              value={topicTitle}
              onChange={(event) => setTopicTitle(event.target.value)}
              autoFocus
              aria-describedby="topicTitle-hint"
            />
          </Field>
          <div className="ui-row" style={{ marginTop: 14 }}>
            <Button
              variant="primary"
              onClick={createTopic}
              disabled={topicTitle.trim().length < 2}
              loading={busy}
              loadingLabel="Adding…"
            >
              Add topic
            </Button>
            <Button variant="ghost" onClick={() => setAddingTopic(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : (
        topics.length > 0 && (
          <div>
            <Button variant="secondary" onClick={() => setAddingTopic(true)}>
              Add another topic
            </Button>
          </div>
        )
      )}
    </>
  );
}

/**
 * The outcome form. Live quality feedback under the statement box, because the
 * moment to fix a statement is while it is being written, not in a review three
 * weeks later.
 */
function OutcomeForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial?: Outcome;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: {
    code: string;
    statement: string;
    bloomLevel: string;
    competency: string;
    typicalMarks: number;
  }) => void;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [statement, setStatement] = useState(initial?.statement ?? "");
  const [bloomLevel, setBloomLevel] = useState(initial?.bloomLevel ?? "UNDERSTAND");
  const [competency, setCompetency] = useState(
    initial?.competency ?? "UNDERSTANDING",
  );
  const [typicalMarks, setTypicalMarks] = useState(initial?.typicalMarks ?? 1);

  // The same function the server runs on save, so the warning shown while
  // typing is exactly the verdict that gets recorded. One implementation.
  const quality = checkOutcomeStatement(statement);

  return (
    <div className="ui-outcome-form">
      <div className="ui-outcome-form-row">
        <Field
          label="Code"
          htmlFor={`code-${initial?.id ?? "new"}`}
          hint="Short and stable — questions point at it."
        >
          <Input
            id={`code-${initial?.id ?? "new"}`}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={24}
            placeholder="SIM-1"
          />
        </Field>
        <Field label="Marks" htmlFor={`marks-${initial?.id ?? "new"}`}>
          <Input
            id={`marks-${initial?.id ?? "new"}`}
            type="number"
            min={1}
            max={10}
            value={typicalMarks}
            onChange={(event) => setTypicalMarks(Number(event.target.value))}
          />
        </Field>
      </div>

      <Field
        label="What can the student do?"
        htmlFor={`statement-${initial?.id ?? "new"}`}
      >
        <textarea
          id={`statement-${initial?.id ?? "new"}`}
          className="ui-textarea"
          rows={3}
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          placeholder="Applies the AA, SSS and SAS similarity criteria to decide whether two given triangles are similar, and names which criterion was used."
        />
      </Field>

      {statement.trim().length > 0 &&
        (quality.ok ? (
          <p className="ui-outcome-ok">
            <span aria-hidden="true">✓</span> A question could be written from
            this.
          </p>
        ) : (
          <p className="ui-outcome-warning">
            <span aria-hidden="true">⚠</span> {quality.reason}
          </p>
        ))}

      <div className="ui-outcome-form-row">
        <Field label="Bloom level" htmlFor={`bloom-${initial?.id ?? "new"}`}>
          <Select
            id={`bloom-${initial?.id ?? "new"}`}
            value={bloomLevel}
            onChange={(event) => setBloomLevel(event.target.value)}
          >
            {BLOOM.map((level) => (
              <option key={level} value={level}>
                {label(level)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Competency" htmlFor={`comp-${initial?.id ?? "new"}`}>
          <Select
            id={`comp-${initial?.id ?? "new"}`}
            value={competency}
            onChange={(event) => setCompetency(event.target.value)}
          >
            {COMPETENCY.map((item) => (
              <option key={item} value={item}>
                {label(item)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="ui-row" style={{ marginTop: 14 }}>
        <Button
          variant="primary"
          loading={busy}
          loadingLabel="Saving…"
          disabled={code.trim().length === 0 || statement.trim().length === 0}
          onClick={() =>
            onSubmit({ code, statement, bloomLevel, competency, typicalMarks })
          }
        >
          {initial ? "Save changes" : "Add outcome"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {!quality.ok && statement.trim().length > 0 && (
        <p className="ui-hint" style={{ marginTop: 8 }}>
          You can save it anyway — this is a warning, not a rule.
        </p>
      )}
    </div>
  );
}
