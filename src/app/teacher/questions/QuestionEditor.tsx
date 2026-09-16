"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  hasOptions,
  isObjective,
  SUBJECTIVE_TYPES,
  validateQuestion,
  type AnswerKey,
  type Option,
  type Problem,
  type QuestionType,
} from "@/core/questions/validate";
import { MAX_CRITERIA, validateRubric, type Rubric } from "@/core/questions/rubric";
import { Alert, Badge, Button, Card, Field, Input, Select } from "@/ui";

type SubjectOption = { id: string; label: string };
type ChapterOption = { id: string; label: string; subjectId: string };
type OutcomeOption = { id: string; label: string; chapterId: string };

export type EditorInitial = {
  id?: string;
  status?: string;
  version?: number;
  type: QuestionType;
  /** Empty for a new question: the teacher chooses, nothing is defaulted. */
  subjectId: string;
  chapterId: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
  expectedTimeSeconds?: number | null;
  stem: string;
  options: Option[] | null;
  answerKey: AnswerKey;
  explanation: string | null;
  hint: string | null;
  rubric?: Rubric | null;
  outcomeIds: string[];
};

const TYPES: { value: QuestionType; label: string; note: string }[] = [
  { value: "MCQ", label: "Multiple choice", note: "One correct option" },
  { value: "MULTI_SELECT", label: "Multi-select", note: "More than one correct option" },
  { value: "TRUE_FALSE", label: "True or false", note: "" },
  { value: "NUMERIC", label: "Numeric answer", note: "Marked with a tolerance" },
  { value: "FILL_BLANK", label: "Fill the blank", note: "Marked against accepted answers" },
  { value: "ASSERTION_REASON", label: "Assertion–reason", note: "One correct option" },
  { value: "VSA", label: "Very short answer", note: "Marked by you" },
  { value: "SA", label: "Short answer", note: "Marked by you" },
  { value: "LA", label: "Long answer", note: "Marked by you" },
  { value: "CASE_STUDY", label: "Case study", note: "Passage and parts, marked by you" },
];

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

/**
 * The four options every CBSE assertion–reason item uses, in the order the
 * board prints them. Offered, not imposed: they are ordinary options and the
 * teacher can edit them.
 */
const ASSERTION_REASON_OPTIONS = [
  "Both A and R are true, and R is the correct explanation of A.",
  "Both A and R are true, but R is not the correct explanation of A.",
  "A is true, but R is false.",
  "A is false, but R is true.",
];

function blankOptions(count = 4): Option[] {
  return Array.from({ length: count }, (_, index) => ({
    key: LETTERS[index]!,
    text: "",
    isCorrect: index === 0,
  }));
}

function assertionReasonOptions(): Option[] {
  return ASSERTION_REASON_OPTIONS.map((text, index) => ({
    key: LETTERS[index]!,
    text,
    isCorrect: index === 0,
  }));
}

/** Split a stored "Assertion (A): … Reason (R): …" stem back into its halves. */
function splitAssertion(stem: string): { assertion: string; reason: string } | null {
  const match = /^\s*Assertion\s*\(A\)\s*:\s*([\s\S]*?)\s*Reason\s*\(R\)\s*:\s*([\s\S]*)$/i.exec(stem);
  if (!match) return null;
  return { assertion: match[1]!.trim(), reason: match[2]!.trim() };
}

type DraftCriterion = { id: string; label: string; marks: string; descriptor: string };

let criterionSeq = 0;
function newCriterionId(): string {
  criterionSeq += 1;
  return `c${Date.now().toString(36)}${criterionSeq}`;
}

/**
 * The question editor.
 *
 * Validation runs live, with the SAME function the server applies on save and
 * that AI generation will run before a draft reaches a human. Errors block;
 * warnings are shown and never enforced — an author may know better than a
 * heuristic, and a rule that fires on good questions gets ignored on bad ones.
 * The mark scheme is checked the same way, by `validateRubric`.
 */
export function QuestionEditor({
  initial,
  subjects,
  chapters,
  outcomes,
  onCancel,
  onSaved,
}: {
  initial: EditorInitial;
  subjects: SubjectOption[];
  chapters: ChapterOption[];
  outcomes: OutcomeOption[];
  /** Editing an existing question: leave edit mode without saving. */
  onCancel?: () => void;
  /** Editing an existing question: saved, so leave edit mode. */
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [type, setType] = useState<QuestionType>(initial.type);
  const [subjectId, setSubjectId] = useState(initial.subjectId);
  const [chapterId, setChapterId] = useState(initial.chapterId ?? "");
  const [difficulty, setDifficulty] = useState(initial.difficulty);
  const [marks, setMarks] = useState(initial.marks);
  const [expectedTime, setExpectedTime] = useState(
    initial.expectedTimeSeconds ? String(initial.expectedTimeSeconds) : "",
  );
  const initialSplit = initial.type === "ASSERTION_REASON" ? splitAssertion(initial.stem) : null;
  const [stem, setStem] = useState(initialSplit ? "" : initial.stem);
  const [assertion, setAssertion] = useState(initialSplit?.assertion ?? "");
  const [reason, setReason] = useState(initialSplit?.reason ?? "");
  const [options, setOptions] = useState<Option[]>(
    initial.options ??
      (initial.type === "ASSERTION_REASON" ? assertionReasonOptions() : blankOptions()),
  );
  const [trueFalse, setTrueFalse] = useState(
    initial.answerKey?.kind === "boolean" ? initial.answerKey.correct : true,
  );
  const [numericValue, setNumericValue] = useState(
    initial.answerKey?.kind === "numeric" ? String(initial.answerKey.value) : "",
  );
  const [tolerance, setTolerance] = useState(
    initial.answerKey?.kind === "numeric" ? String(initial.answerKey.tolerance) : "0.01",
  );
  const [accepted, setAccepted] = useState(
    initial.answerKey?.kind === "text" ? initial.answerKey.accepted.join("\n") : "",
  );
  const [explanation, setExplanation] = useState(initial.explanation ?? "");
  const [hint, setHint] = useState(initial.hint ?? "");
  const [criteria, setCriteria] = useState<DraftCriterion[]>(
    (initial.rubric?.criteria ?? []).map((criterion) => ({
      id: criterion.id,
      label: criterion.label,
      marks: String(criterion.marks),
      descriptor: criterion.descriptor ?? "",
    })),
  );
  const [outcomeIds, setOutcomeIds] = useState<string[]>(initial.outcomeIds);
  const [busy, setBusy] = useState<false | "save" | "approve">(false);
  const [error, setError] = useState<string | null>(null);

  const subjectChapters = chapters.filter((c) => c.subjectId === subjectId);
  const chapterOutcomes = outcomes.filter((o) => o.chapterId === chapterId);
  const subjective = SUBJECTIVE_TYPES.includes(type);

  // Assertion–reason items are authored as two halves and stored as one stem,
  // in the wording the board prints, so the player shows them unchanged.
  const composedStem =
    type === "ASSERTION_REASON"
      ? `Assertion (A): ${assertion.trim()}\nReason (R): ${reason.trim()}`
      : stem;

  const answerKey: AnswerKey = useMemo(() => {
    if (type === "TRUE_FALSE") return { kind: "boolean", correct: trueFalse };
    if (type === "NUMERIC") {
      return {
        kind: "numeric",
        // Blank is NaN, not Number("") === 0 — the validator refuses it.
        value: numericValue.trim() === "" ? Number.NaN : Number(numericValue),
        tolerance: tolerance.trim() === "" ? Number.NaN : Number(tolerance),
      };
    }
    if (type === "FILL_BLANK") {
      return {
        kind: "text",
        accepted: accepted.split("\n").map((a) => a.trim()).filter(Boolean),
        caseSensitive: false,
      };
    }
    return null;
  }, [type, trueFalse, numericValue, tolerance, accepted]);

  const rubric: Rubric | null =
    subjective && criteria.length > 0
      ? {
          criteria: criteria.map((criterion) => ({
            id: criterion.id,
            label: criterion.label.trim(),
            marks: criterion.marks.trim() === "" ? Number.NaN : Number(criterion.marks),
            descriptor: criterion.descriptor.trim() || null,
          })),
        }
      : null;
  const rubricProblems = validateRubric(rubric, marks);
  const rubricTotal = criteria.reduce((sum, c) => {
    const value = Number(c.marks);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  const validation = validateQuestion({
    type,
    stem: type === "ASSERTION_REASON" && (!assertion.trim() || !reason.trim()) ? "" : composedStem,
    options: hasOptions(type) ? options : null,
    answerKey,
    explanation,
    hint,
    marks,
    outcomeIds,
  });

  const expectedSeconds = expectedTime.trim() === "" ? null : Number(expectedTime);
  const expectedTimeError =
    expectedSeconds !== null &&
    (!Number.isInteger(expectedSeconds) || expectedSeconds < 5 || expectedSeconds > 3600)
      ? "A whole number of seconds, between 5 and 3600."
      : null;

  const errors: Problem[] = validation.problems.filter((p) => p.severity === "error");
  if (type === "ASSERTION_REASON" && (!assertion.trim() || !reason.trim())) {
    errors.unshift({
      severity: "error",
      field: "stem",
      message: "Write both the assertion and the reason.",
    });
  }
  if (!subjectId) {
    errors.unshift({
      severity: "error",
      field: "outcomes",
      message: "Choose the subject this question belongs to.",
    });
  }
  const warnings = validation.problems.filter((p) => p.severity === "warning");
  const blocked = errors.length > 0 || rubricProblems.length > 0 || expectedTimeError !== null;

  function setOption(index: number, patch: Partial<Option>) {
    setOptions((current) =>
      current.map((option, i) => (i === index ? { ...option, ...patch } : option)),
    );
  }

  function markCorrect(index: number) {
    setOptions((current) =>
      current.map((option, i) => ({
        ...option,
        // Multi-select toggles; the single-answer types move the mark, because
        // two correct answers on a one-answer question is the error that costs
        // a student a mark they earned.
        isCorrect:
          type === "MULTI_SELECT"
            ? i === index
              ? !option.isCorrect
              : option.isCorrect
            : i === index,
      })),
    );
  }

  function setCriterion(index: number, patch: Partial<DraftCriterion>) {
    setCriteria((current) =>
      current.map((criterion, i) => (i === index ? { ...criterion, ...patch } : criterion)),
    );
  }

  async function save(thenApprove: boolean) {
    setBusy(thenApprove ? "approve" : "save");
    setError(null);

    const body = {
      type,
      subjectId,
      chapterId: chapterId || null,
      difficulty,
      marks,
      expectedTimeSeconds: expectedSeconds,
      stem: composedStem,
      options: hasOptions(type) ? options : null,
      answerKey,
      explanation: explanation.trim() || null,
      hint: hint.trim() || null,
      rubric,
      outcomeIds,
    };

    try {
      const response = await fetch(
        initial.id ? `/api/questions/${initial.id}/` : "/api/questions/",
        {
          method: initial.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(
          payload?.error?.message ??
            "That did not save. Nothing was changed.",
        );
        setBusy(false);
        return;
      }

      const id = initial.id ?? payload?.id;

      if (thenApprove && id) {
        const approval = await fetch(`/api/questions/${id}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        });
        if (!approval.ok) {
          const problem = await approval.json().catch(() => null);
          setError(
            problem?.error?.message ??
              "Saved, but it could not be approved yet.",
          );
          setBusy(false);
          if (!initial.id) router.push(`/teacher/questions/${id}`);
          router.refresh();
          return;
        }
      }

      // Editing happens ON the question's own page, so pushing to that same
      // URL changed nothing and left the button spinning on "Saving…" forever.
      // Leave edit mode and re-read the page instead.
      setBusy(false);
      if (initial.id) {
        onSaved?.();
        router.refresh();
        return;
      }
      router.push(id ? `/teacher/questions/${id}` : "/teacher/questions");
    } catch {
      setError("We could not reach the server. Nothing was saved.");
      setBusy(false);
    }
  }

  return (
    <div className="ui-editor">
      <div className="ui-editor-main">
        {error && <Alert tone="danger">{error}</Alert>}

        <Card title="The question">
          <div className="ui-editor-row">
            <Field label="Type" htmlFor="type">
              <Select
                id="type"
                value={type}
                onChange={(event) => {
                  const next = event.target.value as QuestionType;
                  setType(next);
                  if (next === "ASSERTION_REASON") {
                    const blank = options.every((option) => !option.text.trim());
                    if (blank) setOptions(assertionReasonOptions());
                    const split = splitAssertion(stem);
                    if (split) {
                      setAssertion(split.assertion);
                      setReason(split.reason);
                    } else if (stem.trim() && !assertion.trim()) {
                      setAssertion(stem.trim());
                    }
                  } else {
                    if (type === "ASSERTION_REASON" && (assertion.trim() || reason.trim())) {
                      setStem(composedStem);
                    }
                    if (hasOptions(next) && options.length === 0) {
                      setOptions(blankOptions());
                    }
                  }
                }}
              >
                {TYPES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                    {item.note ? ` — ${item.note}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Difficulty" htmlFor="difficulty">
              <Select
                id="difficulty"
                value={difficulty}
                onChange={(event) =>
                  setDifficulty(event.target.value as typeof difficulty)
                }
              >
                <option value="EASY">Easy</option>
                <option value="MEDIUM">Medium</option>
                <option value="HARD">Hard</option>
              </Select>
            </Field>
            <Field label="Marks" htmlFor="marks">
              <Input
                id="marks"
                type="number"
                min={1}
                max={20}
                value={marks}
                onChange={(event) => setMarks(Number(event.target.value))}
              />
            </Field>
          </div>

          {type === "ASSERTION_REASON" ? (
            <>
              <Field label="Assertion (A)" htmlFor="assertion">
                <textarea
                  id="assertion"
                  className="ui-textarea"
                  rows={2}
                  value={assertion}
                  onChange={(event) => setAssertion(event.target.value)}
                  placeholder="The statement a student judges true or false."
                />
              </Field>
              <Field label="Reason (R)" htmlFor="reason">
                <textarea
                  id="reason"
                  className="ui-textarea"
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="The statement offered as its explanation."
                />
              </Field>
            </>
          ) : (
            <Field
              label={type === "CASE_STUDY" ? "Passage and parts" : "Question"}
              htmlFor="stem"
              hint={
                type === "CASE_STUDY"
                  ? "The passage or data first, then each part on its own line: (i), (ii), (iii)."
                  : undefined
              }
            >
              <textarea
                id="stem"
                className="ui-textarea"
                rows={type === "CASE_STUDY" ? 10 : 4}
                value={stem}
                onChange={(event) => setStem(event.target.value)}
                placeholder="Write the question exactly as a student will read it."
                aria-describedby={type === "CASE_STUDY" ? "stem-hint" : undefined}
              />
            </Field>
          )}

          {hasOptions(type) && (
            <div className="ui-options">
              <span className="ui-label">
                Options
                <span className="ui-label-optional">
                  {type === "MULTI_SELECT"
                    ? "tick every correct one"
                    : "tick the correct one"}
                </span>
              </span>
              {options.map((option, index) => (
                <div key={option.key} className="ui-option-row">
                  <button
                    type="button"
                    className="ui-option-mark"
                    data-correct={option.isCorrect || undefined}
                    onClick={() => markCorrect(index)}
                    aria-pressed={option.isCorrect}
                    aria-label={`Mark option ${option.key} correct`}
                  >
                    {option.key}
                  </button>
                  <Input
                    value={option.text}
                    onChange={(event) => setOption(index, { text: event.target.value })}
                    placeholder={`Option ${option.key}`}
                    aria-label={`Option ${option.key} text`}
                  />
                  {options.length > 2 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setOptions((current) =>
                          current
                            .filter((_, i) => i !== index)
                            .map((o, i) => ({ ...o, key: LETTERS[i]! })),
                        )
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
              {options.length < 8 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setOptions((current) => [
                      ...current,
                      { key: LETTERS[current.length]!, text: "", isCorrect: false },
                    ])
                  }
                >
                  Add an option
                </Button>
              )}
            </div>
          )}

          {type === "TRUE_FALSE" && (
            <Field label="The statement is" htmlFor="trueFalse">
              <Select
                id="trueFalse"
                value={trueFalse ? "true" : "false"}
                onChange={(event) => setTrueFalse(event.target.value === "true")}
              >
                <option value="true">True</option>
                <option value="false">False</option>
              </Select>
            </Field>
          )}

          {type === "NUMERIC" && (
            <div className="ui-editor-row">
              <Field label="Answer" htmlFor="numericValue">
                <Input
                  id="numericValue"
                  type="number"
                  step="any"
                  value={numericValue}
                  invalid={numericValue.trim() === ""}
                  onChange={(event) => setNumericValue(event.target.value)}
                />
              </Field>
              <Field
                label="Tolerance"
                htmlFor="tolerance"
                hint="A student who rounds differently should not be wrong."
              >
                <Input
                  id="tolerance"
                  type="number"
                  step="any"
                  min={0}
                  value={tolerance}
                  onChange={(event) => setTolerance(event.target.value)}
                  aria-describedby="tolerance-hint"
                />
              </Field>
            </div>
          )}

          {type === "FILL_BLANK" && (
            <Field
              label="Accepted answers"
              htmlFor="accepted"
              hint="One per line. Case is ignored. List every form you would mark right."
            >
              <textarea
                id="accepted"
                className="ui-textarea"
                rows={3}
                value={accepted}
                onChange={(event) => setAccepted(event.target.value)}
                aria-describedby="accepted-hint"
              />
            </Field>
          )}

          <Field
            label={isObjective(type) ? "Explanation" : "What a full-mark answer contains"}
            htmlFor="explanation"
            hint={
              isObjective(type)
                ? "Shown after the test. Without it, a student who got this wrong learns only that they were wrong."
                : "Written down now, this is what makes marking fast later."
            }
          >
            <textarea
              id="explanation"
              className="ui-textarea"
              rows={3}
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
              aria-describedby="explanation-hint"
            />
          </Field>

          <div className="ui-editor-row">
            <Field
              label="Hint"
              htmlFor="hint"
              optional
              hint="A nudge towards the method. Never the answer."
            >
              <Input
                id="hint"
                value={hint}
                maxLength={1000}
                onChange={(event) => setHint(event.target.value)}
                aria-describedby="hint-hint"
              />
            </Field>
            <Field
              label="Expected time (seconds)"
              htmlFor="expectedTime"
              optional
              hint="How long a prepared student needs. Used to size papers."
              error={expectedTimeError ?? undefined}
            >
              <Input
                id="expectedTime"
                type="number"
                min={5}
                max={3600}
                step={5}
                value={expectedTime}
                invalid={expectedTimeError !== null}
                onChange={(event) => setExpectedTime(event.target.value)}
                aria-describedby={expectedTimeError ? "expectedTime-error" : "expectedTime-hint"}
              />
            </Field>
          </div>
        </Card>

        {subjective && (
          <Card
            title="Mark scheme"
            description="Optional. What each mark is for, so the twentieth answer is marked like the first. The criteria must add up to the question's marks."
          >
            {criteria.length === 0 ? (
              <p className="ui-hint">
                No mark scheme. You will type a total when marking.
              </p>
            ) : (
              <div className="ui-options">
                {criteria.map((criterion, index) => {
                  // A criterion just added and not yet typed into is not wrong
                  // yet; the Checks card still says the scheme is incomplete.
                  const pristine = !criterion.label && !criterion.marks;
                  const own = pristine ? [] : rubricProblems.filter((p) => p.index === index);
                  return (
                    <div key={criterion.id} className="ui-rubric-row">
                      <Field
                        label={`Criterion ${index + 1}`}
                        htmlFor={`criterion-label-${index}`}
                        error={own.find((p) => p.field === "label")?.message}
                      >
                        <Input
                          id={`criterion-label-${index}`}
                          value={criterion.label}
                          placeholder="e.g. Method"
                          maxLength={120}
                          invalid={own.some((p) => p.field === "label")}
                          onChange={(event) => setCriterion(index, { label: event.target.value })}
                        />
                      </Field>
                      <Field
                        label="Marks"
                        htmlFor={`criterion-marks-${index}`}
                        error={own.find((p) => p.field === "marks")?.message}
                      >
                        <Input
                          id={`criterion-marks-${index}`}
                          type="number"
                          min={0.5}
                          step={0.5}
                          value={criterion.marks}
                          invalid={own.some((p) => p.field === "marks")}
                          onChange={(event) => setCriterion(index, { marks: event.target.value })}
                        />
                      </Field>
                      <Field
                        label="What earns them"
                        htmlFor={`criterion-descriptor-${index}`}
                        optional
                      >
                        <Input
                          id={`criterion-descriptor-${index}`}
                          value={criterion.descriptor}
                          maxLength={1000}
                          onChange={(event) =>
                            setCriterion(index, { descriptor: event.target.value })
                          }
                        />
                      </Field>
                      <div style={{ alignSelf: "end" }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove criterion ${index + 1}`}
                          onClick={() =>
                            setCriteria((current) => current.filter((_, i) => i !== index))
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="ui-row" style={{ marginTop: 12, gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              {criteria.length < MAX_CRITERIA && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setCriteria((current) => [
                      ...current,
                      { id: newCriterionId(), label: "", marks: "", descriptor: "" },
                    ])
                  }
                >
                  Add a criterion
                </Button>
              )}
              {criteria.length > 0 && (
                <span className="ui-hint tabular" style={{ margin: 0 }}>
                  Criteria total {rubricTotal} of {marks} marks
                </span>
              )}
            </div>

            {rubricProblems
              .filter((p) => p.index === undefined)
              .map((problem, index) => (
                <p key={index} className="ui-outcome-warning" style={{ marginTop: 10 }}>
                  ⚠ {problem.message}
                </p>
              ))}
          </Card>
        )}
      </div>

      <div className="ui-editor-side">
        <Card title="Where it belongs">
          <Field label="Subject" htmlFor="subjectId">
            <Select
              id="subjectId"
              value={subjectId}
              invalid={!subjectId}
              onChange={(event) => {
                setSubjectId(event.target.value);
                setChapterId("");
                setOutcomeIds([]);
              }}
            >
              <option value="">Choose a subject</option>
              {subjects.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>

          <div style={{ marginTop: 14 }}>
            <Field label="Chapter" htmlFor="chapterId">
              <Select
                id="chapterId"
                value={chapterId}
                disabled={!subjectId}
                onChange={(event) => {
                  setChapterId(event.target.value);
                  setOutcomeIds([]);
                }}
              >
                <option value="">
                  {subjectId ? "Choose a chapter" : "Choose a subject first"}
                </option>
                {subjectChapters.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div style={{ marginTop: 14 }}>
            <span className="ui-label">
              Learning outcome
              <span className="ui-label-optional">what this tests</span>
            </span>
            {!chapterId ? (
              <p className="ui-hint">Choose a chapter first.</p>
            ) : chapterOutcomes.length === 0 ? (
              <p className="ui-hint">
                This chapter has no learning outcomes yet, so a question on it
                cannot tell you what a student has mastered. Ask for outcomes to
                be added, or pick another chapter.
              </p>
            ) : (
              <div className="ui-outcome-picker">
                {chapterOutcomes.map((option) => (
                  <label key={option.id} className="ui-outcome-choice">
                    <input
                      type="checkbox"
                      checked={outcomeIds.includes(option.id)}
                      onChange={(event) =>
                        setOutcomeIds((current) =>
                          event.target.checked
                            ? [...current, option.id]
                            : current.filter((id) => id !== option.id),
                        )
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card title="Checks">
          {errors.length === 0 && warnings.length === 0 && rubricProblems.length === 0 ? (
            <p className="ui-outcome-ok">
              <span aria-hidden="true">✓</span> Nothing to flag.
            </p>
          ) : (
            <ul className="ui-check-list">
              {errors.map((problem, index) => (
                <ProblemRow key={`e${index}`} problem={problem} />
              ))}
              {rubricProblems.length > 0 && (
                <ProblemRow
                  problem={{
                    severity: "error",
                    field: "marks",
                    message: `Mark scheme: ${rubricProblems[0]!.message}`,
                  }}
                />
              )}
              {warnings.map((problem, index) => (
                <ProblemRow key={`w${index}`} problem={problem} />
              ))}
            </ul>
          )}
          {warnings.length > 0 && !blocked && (
            <p className="ui-hint" style={{ marginTop: 10 }}>
              Warnings do not stop you saving. They are what a reviewer would
              have said.
            </p>
          )}
        </Card>

        <div className="ui-editor-actions">
          <Button
            variant="primary"
            fullWidth
            disabled={blocked || busy !== false}
            loading={busy === "save"}
            loadingLabel="Saving…"
            onClick={() => save(false)}
          >
            {initial.id ? "Save changes" : "Save as draft"}
          </Button>
          <Button
            variant="secondary"
            fullWidth
            disabled={!validation.approvable || blocked || busy !== false}
            loading={busy === "approve"}
            loadingLabel="Saving and approving…"
            onClick={() => save(true)}
          >
            Save and approve
          </Button>
          {onCancel && (
            <Button variant="ghost" fullWidth disabled={busy !== false} onClick={onCancel}>
              Cancel
            </Button>
          )}
          {!validation.approvable && errors.length === 0 && (
            <p className="ui-hint">
              Link a learning outcome to approve it — otherwise it can be scored
              but will never tell you what a student has mastered.
            </p>
          )}
          {initial.status === "APPROVED" && (
            <Alert tone="info">
              Saving an approved question creates version{" "}
              {(initial.version ?? 1) + 1} and returns it to draft. Tests already
              taken keep marking against version {initial.version}.
            </Alert>
          )}
        </div>
      </div>
    </div>
  );
}

function ProblemRow({ problem }: { problem: Problem }) {
  return (
    <li data-severity={problem.severity}>
      <Badge tone={problem.severity === "error" ? "danger" : "warning"}>
        {problem.severity === "error" ? "Must fix" : "Consider"}
      </Badge>
      <span>{problem.message}</span>
    </li>
  );
}
