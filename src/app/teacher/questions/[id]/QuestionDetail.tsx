"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AnswerKey, Option, QuestionType } from "@/core/questions/validate";
import type { Rubric } from "@/core/questions/rubric";
import type { QuestionItemStats } from "@/core/itemstats";
import { Alert, Badge, Button, Card, Row, type Tone } from "@/ui";
import { QuestionEditor } from "../QuestionEditor";
import { ItemStatistics } from "./ItemStatistics";

type Question = {
  id: string;
  status: string;
  source: string;
  aiFlags: { code: string; note: string }[];
  type: QuestionType;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
  subjectId: string;
  subjectName: string;
  chapterId: string | null;
  chapterTitle: string | null;
  outcomeIds: string[];
  version: number;
  versionCount: number;
  stem: string;
  options: Option[] | null;
  answerKey: AnswerKey;
  explanation: string | null;
  hint: string | null;
  expectedTimeSeconds: number | null;
  rubric: Rubric | null;
  rejectionReason: string | null;
  validation: {
    approvable: boolean;
    problems: { severity: string; message: string }[];
  };
};

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "neutral",
  IN_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  ARCHIVED: "neutral",
};

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

// Sentence case for enum values that are words. Acronyms get a real label from
// the map above rather than being mangled into "Mcq".
const label = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");

export function QuestionDetail({
  question,
  subjects,
  chapters,
  outcomes,
  stats,
}: {
  question: Question;
  subjects: { id: string; label: string }[];
  chapters: { id: string; label: string; subjectId: string }[];
  outcomes: { id: string; label: string; chapterId: string }[];
  /**
   * Classical item statistics, derived at read time and stored nowhere. Null
   * only when the question could not be read at all — a question with no
   * answers yet still arrives, carrying its own refusal.
   */
  stats: QuestionItemStats | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  // WHICH action is running, not merely that one is. One shared flag put
  // "Approving…" on the Approve button while Reject or Archive was the request
  // in flight.
  const [busy, setBusy] = useState<false | "approve" | "reject" | "archive">(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "reject" | "archive") {
    let reason: string | undefined;

    if (action === "reject") {
      // A rejection with no reason is a dead end for whoever wrote it.
      const given = window.prompt(
        "Why is this being rejected?\n\nWhoever wrote it will see this, so say what would fix it.",
      );
      if (!given?.trim()) return;
      reason = given.trim();
    }

    if (action === "archive" && !window.confirm("Archive this question?")) {
      return;
    }

    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/questions/${question.id}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "That did not work.");
      } else {
        router.refresh();
      }
    } catch {
      setError("We could not reach the server. Nothing was changed.");
    }
    setBusy(false);
  }

  if (editing) {
    return (
      <QuestionEditor
        initial={{ ...question, version: question.version }}
        subjects={subjects}
        chapters={chapters}
        outcomes={outcomes}
        onCancel={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    );
  }

  const hasCorrectOption = (question.options ?? []).some(
    (option) => option.isCorrect,
  );

  return (
    <div className="ui-editor">
      <div className="ui-editor-main">
        {error && <Alert tone="danger">{error}</Alert>}

        {question.status === "REJECTED" && question.rejectionReason && (
          <Alert tone="danger" title="Rejected">
            {question.rejectionReason}
          </Alert>
        )}

        {question.aiFlags.length > 0 && (
          // Advice, not a verdict. Anything the validator rejected was never
          // saved, so everything here is a judgement the teacher may disagree
          // with — and the reason is shown so they can.
          <Alert
            tone="warning"
            title={
              question.aiFlags.length === 1
                ? "One thing to look at"
                : `${question.aiFlags.length} things to look at`
            }
          >
            <ul className="ui-flag-list">
              {question.aiFlags.map((flag, index) => (
                <li key={index}>{flag.note}</li>
              ))}
            </ul>
          </Alert>
        )}

        <Card>
          <p className="ui-question-full">{question.stem}</p>

          {question.options && question.options.length > 0 && (
            <ul className="ui-answer-list">
              {question.options.map((option) => (
                <li key={option.key} data-correct={option.isCorrect || undefined}>
                  <span className="ui-answer-key">{option.key}</span>
                  <span>{option.text}</span>
                  {option.isCorrect && <Badge tone="success">Correct</Badge>}
                </li>
              ))}
            </ul>
          )}

          {question.answerKey?.kind === "boolean" && (
            <p className="ui-answer-plain">
              Answer:{" "}
              <strong>{question.answerKey.correct ? "True" : "False"}</strong>
            </p>
          )}
          {question.answerKey?.kind === "numeric" && (
            <p className="ui-answer-plain">
              Answer:{" "}
              <strong className="tabular">{question.answerKey.value}</strong>{" "}
              <span className="tabular">plus or minus {question.answerKey.tolerance}</span>
            </p>
          )}
          {question.answerKey?.kind === "text" && (
            <p className="ui-answer-plain">
              Accepted: <strong>{question.answerKey.accepted.join(", ")}</strong>
            </p>
          )}
          {!question.answerKey && !hasCorrectOption && (
            <p className="ui-answer-plain">
              Marked by a person — there is no automatic answer key for this type.
            </p>
          )}

          {question.explanation && (
            <div className="ui-explanation">
              <span className="ui-explanation-label">Explanation</span>
              <p>{question.explanation}</p>
            </div>
          )}

          {question.hint && (
            <div className="ui-explanation">
              <span className="ui-explanation-label">Hint</span>
              <p>{question.hint}</p>
            </div>
          )}

          {question.rubric && (
            <div className="ui-explanation">
              <span className="ui-explanation-label">Mark scheme</span>
              <ul className="ui-check-list">
                {question.rubric.criteria.map((criterion) => (
                  <li key={criterion.id}>
                    <Badge tone="neutral">
                      <span className="tabular">{criterion.marks}</span>
                    </Badge>
                    <span>
                      <strong>{criterion.label}</strong>
                      {criterion.descriptor ? ` — ${criterion.descriptor}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        {stats && <ItemStatistics data={stats} />}
      </div>

      <div className="ui-editor-side">
        <Card title="Status">
          <Row>
            <Badge tone={STATUS_TONE[question.status] ?? "neutral"}>
              {label(question.status)}
            </Badge>
            {question.versionCount > 1 && (
              <Badge tone="neutral">
                Version {question.version} of {question.versionCount}
              </Badge>
            )}
            {question.source === "AI_GENERATED" && (
              <Badge tone="ai">✦ AI drafted</Badge>
            )}
          </Row>
          <dl className="ui-facts">
            <dt>Type</dt>
            <dd>{TYPE_LABEL[question.type] ?? question.type}</dd>
            <dt>Difficulty</dt>
            <dd>{label(question.difficulty)}</dd>
            <dt>Marks</dt>
            <dd className="tabular">{question.marks}</dd>
            <dt>Subject</dt>
            <dd>{question.subjectName}</dd>
            {question.chapterTitle && (
              <>
                <dt>Chapter</dt>
                <dd>{question.chapterTitle}</dd>
              </>
            )}
            <dt>Outcomes</dt>
            <dd>
              {question.outcomeIds.length === 0 ? (
                <Badge tone="warning">None linked</Badge>
              ) : (
                <span className="tabular">{question.outcomeIds.length}</span>
              )}
            </dd>
          </dl>
        </Card>

        {question.validation.problems.length > 0 && (
          <Card title="Checks">
            <ul className="ui-check-list">
              {question.validation.problems.map((problem, index) => (
                <li key={index} data-severity={problem.severity}>
                  <Badge
                    tone={problem.severity === "error" ? "danger" : "warning"}
                  >
                    {problem.severity === "error" ? "Must fix" : "Consider"}
                  </Badge>
                  <span>{problem.message}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="ui-editor-actions">
          <Button variant="secondary" fullWidth onClick={() => setEditing(true)}>
            Edit
          </Button>
          {question.status !== "APPROVED" && (
            <Button
              variant="primary"
              fullWidth
              disabled={!question.validation.approvable || busy !== false}
              loading={busy === "approve"}
              loadingLabel="Approving…"
              onClick={() => act("approve")}
            >
              Approve
            </Button>
          )}
          {question.status !== "REJECTED" && (
            <Button
              variant="ghost"
              fullWidth
              disabled={busy !== false}
              loading={busy === "reject"}
              loadingLabel="Rejecting…"
              onClick={() => act("reject")}
            >
              Reject
            </Button>
          )}
          {question.status !== "ARCHIVED" && (
            <Button
              variant="ghost"
              fullWidth
              disabled={busy !== false}
              loading={busy === "archive"}
              loadingLabel="Archiving…"
              onClick={() => act("archive")}
            >
              Archive
            </Button>
          )}
          {!question.validation.approvable && (
            <p className="ui-hint">
              It cannot be approved until the checks above are cleared.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
