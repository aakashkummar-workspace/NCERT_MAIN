"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  allocate,
  validateBlueprint,
  type Blueprint,
  type Difficulty,
} from "@/core/assessments/blueprint";
import { checkBasics } from "@/core/assessments/basics";
import type { QuestionType } from "@/core/questions/validate";
import { Alert, Badge, Button, Card, Field, Input, Select } from "@/ui";

type BankQuestion = {
  id: string;
  stem: string;
  type: QuestionType;
  difficulty: Difficulty;
  marks: number;
  outcomeCount: number;
  outcomeIds: string[];
  chapterId: string | null;
  chapterNumber: number | null;
  chapterTitle: string | null;
};

const DIFFICULTY_ORDER: Record<Difficulty, number> = { EASY: 0, MEDIUM: 1, HARD: 2 };

/** A number input's value, where blank is NaN rather than Number("") === 0. */
const numberFrom = (value: string) => (value === "" ? Number.NaN : Number(value));
const shown = (value: number) => (Number.isNaN(value) ? "" : value);

type Assessment = {
  id: string;
  title: string;
  status: string;
  subjectName: string;
  gradeLabel: string;
  className: string | null;
  durationMinutes: number;
  totalMarks: number;
  blueprint: Blueprint;
  questions: { questionId: string; marks: number; stem: string }[];
  readiness: { ready: boolean; problems: string[]; marksTotal: number } | null;
};

type Outcome = { id: string; label: string; chapterId: string };
type Chapter = { id: string; label: string; outcomeCount: number };

const STEPS = [
  "Basics",
  "Curriculum",
  "Blueprint",
  "Questions",
  "Review",
  "Publish",
] as const;

const TYPE_LABEL: Record<string, string> = {
  MCQ: "Multiple choice",
  MULTI_SELECT: "Multi-select",
  TRUE_FALSE: "True / false",
  NUMERIC: "Numeric",
  FILL_BLANK: "Fill the blank",
  VSA: "Very short answer",
  SA: "Short answer",
  LA: "Long answer",
  ASSERTION_REASON: "Assertion–reason",
  CASE_STUDY: "Case study",
};

/**
 * The six-step builder.
 *
 * Every step saves as it goes, so leaving never loses work, and the whole
 * thing is a draft until step 6. The steps are navigable in both directions —
 * a teacher who realises at step 4 that the mix was wrong should not have to
 * start again.
 */
export function Builder({
  assessment,
  chapters,
  outcomes,
  bank,
}: {
  assessment: Assessment;
  chapters: Chapter[];
  outcomes: Outcome[];
  bank: BankQuestion[];
}) {
  const router = useRouter();
  const [step, setStep] = useState(assessment.questions.length > 0 ? 4 : 0);
  const [title, setTitle] = useState(assessment.title);
  const [duration, setDuration] = useState(assessment.durationMinutes);
  const [totalMarks, setTotalMarks] = useState(assessment.totalMarks);
  const [blueprint, setBlueprint] = useState<Blueprint>(assessment.blueprint);
  const [selected, setSelected] = useState<string[]>(
    assessment.questions.map((q) => q.questionId),
  );
  const [feasibility, setFeasibility] = useState<{
    supplied: number;
    wanted: number;
    messages: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState<"" | Difficulty>("");
  const [wholeSubject, setWholeSubject] = useState(false);
  /**
   * What the server last confirmed as the paper's questions. The review step
   * reads this, not the page's props: those are refreshed by router.refresh()
   * and arrive a moment AFTER the step changes, so the review used to open on
   * "0 questions · Nothing saved yet" for a paper that had just been saved.
   */
  const [savedIds, setSavedIds] = useState<string[]>(
    assessment.questions.map((q) => q.questionId),
  );

  const basicsErrors = checkBasics({ title, durationMinutes: duration, totalMarks });
  const fieldError = (name: keyof typeof basicsErrors) =>
    basicsErrors[name] ?? serverFields[name];

  const blueprintProblems = validateBlueprint({ ...blueprint, totalMarks });
  const blueprintErrors = blueprintProblems.filter((p) => p.severity === "error");

  // The scope chosen at step 2. A question is in it when it tests a chosen
  // outcome, or sits in a chosen outcome's chapter (a question in the right
  // chapter with no outcome linked is still about that chapter). Nothing
  // chosen means the whole subject, which is the whole bank on this page.
  const chosenOutcomes = new Set(blueprint.outcomeIds);
  const chosenChapters = new Set(
    outcomes.filter((o) => chosenOutcomes.has(o.id)).map((o) => o.chapterId),
  );
  const scoped = chosenOutcomes.size > 0 && !wholeSubject;
  const inScope = bank.filter(
    (question) =>
      !scoped ||
      question.outcomeIds.some((id) => chosenOutcomes.has(id)) ||
      (question.chapterId !== null && chosenChapters.has(question.chapterId)),
  );
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = inScope
    .filter((question) => !difficultyFilter || question.difficulty === difficultyFilter)
    .filter((question) => {
      if (words.length === 0) return true;
      const haystack = `${question.stem} ${question.chapterTitle ?? ""}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort(
      (a, b) =>
        (a.chapterNumber ?? 9999) - (b.chapterNumber ?? 9999) ||
        DIFFICULTY_ORDER[a.difficulty] - DIFFICULTY_ORDER[b.difficulty],
    );
  // A chosen question stays listed even when a filter would hide it, so
  // un-choosing it is always possible from where the teacher is looking.
  const hiddenChosen = selected.filter((id) => !visible.some((q) => q.id === id)).length;

  const byId = new Map(bank.map((question) => [question.id, question]));
  const chosenMarks = selected.reduce((sum, id) => sum + (byId.get(id)?.marks ?? 0), 0);
  const wantedByDifficulty = allocate(blueprint.totalQuestions, blueprint.difficultyMix);
  const chosenByDifficulty = (level: Difficulty) =>
    selected.filter((id) => byId.get(id)?.difficulty === level).length;

  const savedById = new Map(assessment.questions.map((q) => [q.questionId, q]));
  const reviewRows = savedIds.flatMap((questionId) => {
    const saved = savedById.get(questionId);
    const fromBank = byId.get(questionId);
    const stem = saved?.stem ?? fromBank?.stem;
    const marks = saved?.marks ?? fromBank?.marks;
    return stem === undefined || marks === undefined ? [] : [{ questionId, stem, marks }];
  });
  const reviewMarks = reviewRows.reduce((sum, row) => sum + row.marks, 0);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      setError(null);
      setServerFields({});
      try {
        const response = await fetch(`/api/assessments/${assessment.id}/`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
          if (fields && Object.keys(fields).length > 0) {
            setServerFields(fields);
            setError("Fix the fields marked below. Nothing on this step was saved.");
          } else {
            setError(payload?.error?.message ?? "That did not save.");
          }
          return false;
        }
        return true;
      } catch {
        setError("We could not reach the server. Nothing was saved.");
        return false;
      }
    },
    [assessment.id],
  );

  // Feasibility is asked of the server whenever the mix changes, because only
  // the server knows what the bank holds. Debounced so typing a percentage
  // does not fire a request per keystroke.
  useEffect(() => {
    if (step !== 2 || blueprintErrors.length > 0) return;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/assessments/${assessment.id}/feasibility/`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...blueprint, totalMarks }),
          },
        );
        if (response.ok) setFeasibility(await response.json());
      } catch {
        // A failed feasibility check is not worth an error banner — the
        // publish gate will catch anything that matters.
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [step, blueprint, totalMarks, assessment.id, blueprintErrors.length]);

  async function next() {
    setBusy(true);
    // Every step's save decides whether the step advances. Ignoring the result
    // moved a teacher on to step 2 with "Check the highlighted fields" showing
    // and nothing highlighted, and the rejected edits gone from view.
    let saved = true;
    if (step === 0) {
      if (Object.keys(basicsErrors).length > 0) {
        setError("Fix the fields marked below. Nothing on this step was saved.");
        saved = false;
      } else {
        saved = await save({ title, durationMinutes: duration, totalMarks });
      }
    }
    if (step === 1 || step === 2) saved = await save({ blueprint, totalMarks });
    if (step === 3) {
      try {
        const response = await fetch(
          `/api/assessments/${assessment.id}/questions/`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionIds: selected }),
          },
        );
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          setError(payload?.error?.message ?? "Those questions did not save.");
          saved = false;
        } else {
          setSavedIds(selected);
          router.refresh();
        }
      } catch {
        setError("We could not reach the server. Nothing was saved.");
        saved = false;
      }
    }
    setBusy(false);
    if (!saved) return;
    setError(null);
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  }

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assessments/${assessment.id}/publish/`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "It could not be published.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was published.");
    }
    setBusy(false);
  }

  return (
    <div className="ui-builder">
      <ol className="ui-steps" aria-label="Builder steps">
        {STEPS.map((name, index) => (
          <li key={name}>
            <button
              type="button"
              className="ui-step"
              data-state={
                index === step ? "current" : index < step ? "done" : "upcoming"
              }
              onClick={() => {
                if (index > step) return;
                setError(null);
                setStep(index);
              }}
              disabled={index > step}
              aria-current={index === step ? "step" : undefined}
            >
              <span className="ui-step-number">
                {index < step ? "✓" : index + 1}
              </span>
              <span>{name}</span>
            </button>
          </li>
        ))}
      </ol>

      {error && <Alert tone="danger">{error}</Alert>}

      {step === 0 && (
        <Card
          title="Basics"
          description={`${assessment.gradeLabel} · ${assessment.subjectName}`}
        >
          <Field label="Name" htmlFor="title" error={fieldError("title")}>
            <Input
              id="title"
              value={title}
              invalid={Boolean(fieldError("title"))}
              aria-describedby={fieldError("title") ? "title-error" : undefined}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
            />
          </Field>
          <div className="ui-editor-row" style={{ marginTop: 16 }}>
            <Field
              label="Duration (minutes)"
              htmlFor="duration"
              error={fieldError("durationMinutes")}
            >
              <Input
                id="duration"
                type="number"
                min={5}
                max={360}
                value={shown(duration)}
                invalid={Boolean(fieldError("durationMinutes"))}
                aria-describedby={fieldError("durationMinutes") ? "duration-error" : undefined}
                onChange={(event) => setDuration(numberFrom(event.target.value))}
              />
            </Field>
            <Field label="Total marks" htmlFor="totalMarks" error={fieldError("totalMarks")}>
              <Input
                id="totalMarks"
                type="number"
                min={1}
                max={200}
                value={shown(totalMarks)}
                invalid={Boolean(fieldError("totalMarks"))}
                aria-describedby={fieldError("totalMarks") ? "totalMarks-error" : undefined}
                onChange={(event) => setTotalMarks(numberFrom(event.target.value))}
              />
            </Field>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card
          title="What does this cover?"
          description="Pick the learning outcomes. This is what lets the results tell you which concepts the class has secured, rather than only who scored what."
        >
          {chapters.filter((c) => c.outcomeCount > 0).length === 0 ? (
            <Alert tone="warning" title="No chapters have learning outcomes yet">
              You can still build a paper, but its results will show scores and
              nothing about which concepts the class has secured.
            </Alert>
          ) : (
            <div className="ui-scope-list">
              {chapters
                .filter((chapter) => chapter.outcomeCount > 0)
                .map((chapter) => (
                  <div key={chapter.id} className="ui-scope-chapter">
                    <span className="ui-scope-title">{chapter.label}</span>
                    {outcomes
                      .filter((outcome) => outcome.chapterId === chapter.id)
                      .map((outcome) => (
                        <label key={outcome.id} className="ui-outcome-choice">
                          <input
                            type="checkbox"
                            checked={blueprint.outcomeIds.includes(outcome.id)}
                            onChange={(event) =>
                              setBlueprint((current) => ({
                                ...current,
                                outcomeIds: event.target.checked
                                  ? [...current.outcomeIds, outcome.id]
                                  : current.outcomeIds.filter(
                                      (id) => id !== outcome.id,
                                    ),
                              }))
                            }
                          />
                          <span>{outcome.label}</span>
                        </label>
                      ))}
                  </div>
                ))}
            </div>
          )}
        </Card>
      )}

      {step === 2 && (
        <>
          <Card
            title="Blueprint"
            description="The shape of the paper. The mix is a target, not a rule — you can still change any question later."
          >
            <div className="ui-editor-row">
              <Field label="Questions" htmlFor="totalQuestions">
                <Input
                  id="totalQuestions"
                  type="number"
                  min={1}
                  max={100}
                  value={blueprint.totalQuestions}
                  onChange={(event) =>
                    setBlueprint((c) => ({
                      ...c,
                      totalQuestions: Number(event.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="Total marks" htmlFor="bpMarks">
                <Input
                  id="bpMarks"
                  type="number"
                  min={1}
                  max={200}
                  value={totalMarks}
                  onChange={(event) => setTotalMarks(Number(event.target.value))}
                />
              </Field>
            </div>

            <h4>Difficulty</h4>
            <div className="ui-mix">
              {(["EASY", "MEDIUM", "HARD"] as Difficulty[]).map((level) => (
                <Field
                  key={level}
                  label={level.charAt(0) + level.slice(1).toLowerCase()}
                  htmlFor={`mix-${level}`}
                >
                  <Input
                    id={`mix-${level}`}
                    type="number"
                    min={0}
                    max={100}
                    value={blueprint.difficultyMix[level]}
                    onChange={(event) =>
                      setBlueprint((c) => ({
                        ...c,
                        difficultyMix: {
                          ...c.difficultyMix,
                          [level]: Number(event.target.value),
                        },
                      }))
                    }
                  />
                </Field>
              ))}
            </div>

            <h4>Question types</h4>
            <div className="ui-mix">
              {Object.keys(TYPE_LABEL).map((type) => (
                <Field key={type} label={TYPE_LABEL[type]!} htmlFor={`type-${type}`}>
                  <Input
                    id={`type-${type}`}
                    type="number"
                    min={0}
                    max={100}
                    value={blueprint.typeMix[type as QuestionType] ?? 0}
                    onChange={(event) =>
                      setBlueprint((c) => {
                        const next = { ...c.typeMix };
                        const value = Number(event.target.value);
                        if (value > 0) next[type as QuestionType] = value;
                        else delete next[type as QuestionType];
                        return { ...c, typeMix: next };
                      })
                    }
                  />
                </Field>
              ))}
            </div>

            {blueprintProblems.map((problem, index) => (
              <p
                key={index}
                className={
                  problem.severity === "error"
                    ? "ui-outcome-warning"
                    : "ui-hint"
                }
                style={{ marginTop: 10 }}
              >
                {problem.severity === "error" ? "⚠ " : ""}
                {problem.message}
              </p>
            ))}
          </Card>

          {feasibility && (
            <Card title="Can your bank fill this?">
              {feasibility.messages.length === 0 ? (
                <p className="ui-outcome-ok">
                  <span aria-hidden="true">✓</span> Yes — the bank has{" "}
                  {feasibility.supplied} approved{" "}
                  {feasibility.supplied === 1 ? "question" : "questions"} for this
                  plan.
                </p>
              ) : (
                <>
                  <p style={{ margin: "0 0 10px", fontSize: 14 }}>
                    The bank can supply{" "}
                    <strong className="tabular">{feasibility.supplied}</strong> of
                    the <strong className="tabular">{feasibility.wanted}</strong>{" "}
                    questions this plan asks for.
                  </p>
                  <ul className="ui-check-list">
                    {feasibility.messages.map((message, index) => (
                      <li key={index}>
                        <Badge tone="warning">Short</Badge>
                        <span>{message}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="ui-hint" style={{ marginTop: 12 }}>
                    You can carry on and pick whatever the bank does have. This is
                    told to you now so it does not become a surprise at the end.
                  </p>
                </>
              )}
            </Card>
          )}
        </>
      )}

      {step === 3 && (
        <Card
          title="Choose the questions"
          description={`${selected.length} chosen · ${chosenMarks} of ${totalMarks} marks`}
          action={
            // Was a badge reading "AI generation arrives in a later slice".
            // It shipped; a notice telling a teacher to wait for something
            // they can already use is worse than no notice.
            <Link
              href="/teacher/questions/generate"
              className="ui-button"
              data-variant="ghost"
              data-size="sm"
            >
              <span>✦ Generate more questions</span>
            </Link>
          }
        >
          <div className="ui-mix" style={{ marginBottom: 12 }}>
            {(["EASY", "MEDIUM", "HARD"] as Difficulty[]).map((level) => {
              const wanted = wantedByDifficulty[level] ?? 0;
              const chosen = chosenByDifficulty(level);
              return (
                <Badge
                  key={level}
                  tone={chosen === wanted ? "success" : chosen > wanted ? "warning" : "neutral"}
                >
                  {level.charAt(0) + level.slice(1).toLowerCase()}:{" "}
                  <span className="tabular">
                    {chosen} of {wanted}
                  </span>
                </Badge>
              );
            })}
          </div>

          <div className="ui-editor-row" style={{ marginBottom: 12 }}>
            <Field label="Search questions" htmlFor="pick-search">
              <Input
                id="pick-search"
                type="search"
                value={search}
                placeholder="Words in the question or chapter"
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
            <Field label="Difficulty" htmlFor="pick-difficulty">
              <Select
                id="pick-difficulty"
                value={difficultyFilter}
                onChange={(event) =>
                  setDifficultyFilter(event.target.value as "" | Difficulty)
                }
              >
                <option value="">Any difficulty</option>
                <option value="EASY">Easy</option>
                <option value="MEDIUM">Medium</option>
                <option value="HARD">Hard</option>
              </Select>
            </Field>
          </div>

          <p className="ui-hint" style={{ margin: "0 0 12px" }}>
            {scoped
              ? `Showing ${visible.length} of ${inScope.length} approved questions on the ${chosenOutcomes.size} learning outcomes chosen at step 2.`
              : `Showing ${visible.length} of ${inScope.length} approved questions in ${assessment.gradeLabel} ${assessment.subjectName}.`}{" "}
            {chosenOutcomes.size > 0 && (
              <button
                type="button"
                className="ui-link-button"
                onClick={() => setWholeSubject((current) => !current)}
              >
                {wholeSubject ? "Only the chosen outcomes" : "Show the whole subject"}
              </button>
            )}
            {hiddenChosen > 0 && ` ${hiddenChosen} chosen question(s) are hidden by the filters.`}
          </p>

          {inScope.length === 0 ? (
            <Alert tone="warning" title="No approved questions match this scope">
              Write and approve some questions first — a draft cannot go into a
              paper a class will sit.
            </Alert>
          ) : visible.length === 0 ? (
            <Alert tone="info" title="Nothing matches those filters">
              Clear the search or the difficulty to see the rest.
            </Alert>
          ) : (
            <ul className="ui-pick-list">
              {visible.map((question) => {
                const chosen = selected.includes(question.id);
                return (
                  <li key={question.id} data-chosen={chosen || undefined}>
                    <label>
                      <input
                        type="checkbox"
                        checked={chosen}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, question.id]
                              : current.filter((id) => id !== question.id),
                          )
                        }
                      />
                      <span className="ui-pick-stem">{question.stem}</span>
                      <span className="ui-pick-meta">
                        <span>
                          {question.chapterTitle
                            ? `Ch ${question.chapterNumber ?? "?"}. ${question.chapterTitle}`
                            : "No chapter"}
                        </span>
                        <span>{TYPE_LABEL[question.type] ?? question.type}</span>
                        <span>
                          {question.difficulty.charAt(0) +
                            question.difficulty.slice(1).toLowerCase()}
                        </span>
                        <span className="tabular">
                          {question.marks}{" "}
                          {question.marks === 1 ? "mark" : "marks"}
                        </span>
                        {question.outcomeCount === 0 && (
                          <Badge tone="warning">No outcome</Badge>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {step === 4 && (
        <Card
          title="Review"
          description={`${reviewRows.length} questions · ${reviewMarks} of ${totalMarks} marks`}
        >
          {reviewRows.length === 0 ? (
            <p className="ui-hint">
              Nothing saved yet. Go back a step and choose some questions.
            </p>
          ) : (
            <ol className="ui-review-list">
              {reviewRows.map((question, index) => (
                <li key={question.questionId}>
                  <span className="ui-review-number tabular">{index + 1}</span>
                  <span>{question.stem}</span>
                  <span className="ui-review-marks tabular">
                    {question.marks}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {step === 5 && (
        <Card title="Publish">
          {assessment.status === "PUBLISHED" ? (
            <Alert tone="success" title="Published">
              The question versions are frozen, so this paper will keep marking
              the way it does today even if the questions are edited later.
              Assign it to a class below.
            </Alert>
          ) : assessment.readiness?.ready ? (
            <>
              <p style={{ margin: "0 0 14px", fontSize: 14 }}>
                Everything checks out. Publishing freezes the wording of every
                question, so a paper a class has already sat can never change
                underneath them.
              </p>
              <Button
                variant="primary"
                loading={busy}
                loadingLabel="Publishing…"
                onClick={publish}
              >
                Publish
              </Button>
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 10px", fontSize: 14 }}>
                Not ready yet:
              </p>
              <ul className="ui-check-list">
                {(assessment.readiness?.problems ?? []).map((problem, index) => (
                  <li key={index}>
                    <Badge tone="danger">Must fix</Badge>
                    <span>{problem}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      <div className="ui-builder-nav">
        {step > 0 && (
          <Button
            variant="ghost"
            onClick={() => {
              setError(null);
              setStep(step - 1);
            }}
          >
            Back
          </Button>
        )}
        {step < STEPS.length - 1 && (
          <Button
            variant="primary"
            onClick={next}
            loading={busy}
            loadingLabel="Saving…"
            disabled={step === 2 && blueprintErrors.length > 0}
          >
            {step === 3 ? "Save and review" : "Continue"}
          </Button>
        )}
      </div>
    </div>
  );
}
