"use client";

import { useMemo, useRef, useState } from "react";
import type { PaperQuestion, PaperSheet, PaperStudent } from "@/core/paper";
import { omrLayout } from "@/core/omr/layout";
import { sheetRows } from "@/core/omr/paper";
import { readSheet } from "@/core/omr/read";
import { Alert, Button, Card, Field, Input, Select } from "@/ui";
import {
  applyLetters,
  draftFromEntries,
  entriesFromDraft,
  letterQuestions,
  type Draft,
  type DraftAnswer,
} from "./entry";

const TYPE_HINT: Record<string, string> = {
  MCQ: "Choice",
  ASSERTION_REASON: "Assertion–reason",
  MULTI_SELECT: "Tick all chosen",
  TRUE_FALSE: "True / false",
  NUMERIC: "Number",
  FILL_BLANK: "Word",
  VSA: "Written",
  SA: "Written",
  LA: "Written",
  CASE_STUDY: "Written",
};

/** Longest side, in pixels, a photo is reduced to before it is read. */
const SCAN_SIDE = 1400;

function todayIn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * The day the paper was sat, as the moment the server stores. Today means
 * now — a time later today would be "in the future" and refused.
 */
function satOnInstant(date: string): string {
  const today = todayIn(new Date().toISOString());
  if (date === today) return new Date().toISOString();
  return new Date(`${date}T10:00:00+05:30`).toISOString();
}

/**
 * Recording a paper sat on paper.
 *
 * One student at a time, because that is how a pile of sheets is worked
 * through — and three ways to fill the same form: tap each answer, type the
 * letters in one line, or photograph the student's printed answer sheet. All
 * three fill one draft; nothing is saved until the teacher presses Save, and
 * anything the scanner was unsure of is marked on the row, never decided.
 */
export function PaperEntry({ initial }: { initial: PaperSheet }) {
  const [sheet, setSheet] = useState(initial);
  const firstOpen = initial.students.findIndex((s) => !s.recorded && !s.satOnline);
  const [studentId, setStudentId] = useState(
    initial.students[firstOpen >= 0 ? firstOpen : 0]!.userId,
  );
  const student = sheet.students.find((s) => s.userId === studentId)!;
  const [draft, setDraft] = useState<Draft>(() =>
    student.recorded ? draftFromEntries(student.recorded.entries) : {},
  );
  const [satOn, setSatOn] = useState(() =>
    todayIn(student.recorded?.satOn ?? initial.opensAt),
  );
  const [letters, setLetters] = useState("");
  const [flags, setFlags] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "scan" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * A scan read the answers but not whose sheet it was. Choosing a student
   * then moves the scanned answers to them rather than throwing them away.
   */
  const [unowned, setUnowned] = useState(false);

  const sheetLayout = useMemo(() => {
    const rows = sheetRows(sheet.questions);
    return { ...rows, layout: omrLayout(rows.rows) };
  }, [sheet.questions]);

  const recordedCount = sheet.students.filter((s) => s.recorded).length;
  const letterCount = letterQuestions(sheet.questions).length;

  function choose(next: PaperStudent) {
    setStudentId(next.userId);
    setSatOn(todayIn(next.recorded?.satOn ?? sheet.opensAt));
    setError(null);
    if (unowned) {
      setUnowned(false);
      return;
    }
    setDraft(next.recorded ? draftFromEntries(next.recorded.entries) : {});
    setLetters("");
    setFlags({});
  }

  function set(question: PaperQuestion, answer: DraftAnswer) {
    setDraft((current) => ({ ...current, [question.assessmentQuestionId]: answer }));
    setFlags((current) => {
      if (!current[question.assessmentQuestionId]) return current;
      const next = { ...current };
      delete next[question.assessmentQuestionId];
      return next;
    });
  }

  function fillLetters() {
    const result = applyLetters(sheet.questions, draft, letters);
    setDraft(result.draft);
    setError(result.problems.length > 0 ? result.problems.join(" ") : null);
  }

  async function scan(file: File) {
    setBusy("scan");
    setError(null);
    setNotice(null);
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, SCAN_SIDE / Math.max(bitmap.width, bitmap.height));
      const width = Math.round(bitmap.width * scale);
      const height = Math.round(bitmap.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("no canvas");
      context.drawImage(bitmap, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const reading = readSheet(pixels, sheetLayout.layout);
      if (!reading.ok) {
        setError(reading.message);
        setBusy(null);
        return;
      }

      // Whose sheet: the identity strip, matched against THIS paper's roster.
      const owners = reading.sheetIdValid
        ? sheet.students.filter((s) => s.sheetCode === reading.sheetId)
        : [];
      const owner = owners.length === 1 ? owners[0]! : null;
      const target = owner ?? student;

      const next: Draft = owner
        ? target.recorded
          ? draftFromEntries(target.recorded.entries)
          : {}
        : { ...draft };
      const nextFlags: Record<string, string> = {};
      let read = 0;
      reading.questions.forEach((row, index) => {
        const id = sheetLayout.ids[index]!;
        const question = sheet.questions.find((q) => q.assessmentQuestionId === id)!;
        if (row.status === "ok") {
          read++;
          next[id] =
            question.type === "TRUE_FALSE"
              ? { kind: "boolean", value: row.keys[0] === "T" }
              : { kind: "choice", keys: row.keys };
        } else if (row.status === "blank") {
          next[id] = { kind: "blank" };
        } else if (question.type === "MULTI_SELECT" && row.status === "multiple") {
          read++;
          next[id] = { kind: "choice", keys: row.keys };
        } else {
          next[id] = { kind: "blank" };
          nextFlags[id] =
            row.status === "multiple"
              ? `More than one circle is filled (${row.keys.join(", ")}). Check the sheet and choose.`
              : `A faint mark (${row.keys.join(", ")}). Check the sheet and choose.`;
        }
      });

      if (owner) {
        setStudentId(owner.userId);
        setSatOn(todayIn(owner.recorded?.satOn ?? sheet.opensAt));
      }
      setUnowned(!owner);
      setDraft(next);
      setFlags(nextFlags);
      setLetters("");
      const toCheck = Object.keys(nextFlags).length;
      setNotice(
        (owner
          ? `Read ${owner.fullName}'s sheet: ${read} answers.`
          : `Read the answers (${read}), but not whose sheet it is — they are filled in for ${student.fullName}. Choose the right student above if that is wrong.`) +
          (toCheck > 0 ? ` ${toCheck} to check, marked below.` : " Check them against the sheet, then save.") +
          (owners.length > 1 ? " Two students share this sheet number — choose the right one above." : ""),
      );
    } catch {
      setError("That photo could not be opened. Try again, or take a new one.");
    }
    setBusy(null);
  }

  async function save() {
    const built = entriesFromDraft(sheet.questions, draft);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    if (Object.keys(flags).length > 0) {
      setError("Some answers from the scan still need checking — they are marked below.");
      return;
    }
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/assignments/${sheet.assignmentId}/paper/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentUserId: student.userId,
          entries: built.entries,
          satOn: satOnInstant(satOn),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "That did not save.");
        setBusy(null);
        return;
      }
      const refreshed = await fetch(`/api/assignments/${sheet.assignmentId}/paper/`);
      const nextSheet: PaperSheet = refreshed.ok ? await refreshed.json() : sheet;
      setSheet(nextSheet);
      const pending = payload.pendingMarks > 0 ? ` ${payload.pendingMarks} marks still to mark.` : "";
      const saved = `${student.fullName}: saved, ${payload.rawScore} of ${payload.maxScore} so far.${pending}`;
      // On to the next student with nothing recorded, in roll order.
      const order = nextSheet.students;
      const here = order.findIndex((s) => s.userId === student.userId);
      const upcoming =
        order.slice(here + 1).find((s) => !s.recorded && !s.satOnline) ??
        order.find((s) => !s.recorded && !s.satOnline);
      setUnowned(false);
      if (upcoming) {
        setStudentId(upcoming.userId);
        setSatOn(todayIn(upcoming.recorded?.satOn ?? nextSheet.opensAt));
        setDraft(upcoming.recorded ? draftFromEntries(upcoming.recorded.entries) : {});
        setLetters("");
        setFlags({});
      }
      setNotice(upcoming ? `${saved} Now: ${upcoming.fullName}.` : `${saved} Every student is recorded.`);
    } catch {
      setError("We could not reach the server. Nothing was saved — your entries are still here.");
    }
    setBusy(null);
  }

  return (
    <div className="ui-entry">
      <Card>
        <div className="ui-entry-top">
          <Field label="Student" htmlFor="entry-student">
            <Select
              id="entry-student"
              value={studentId}
              onChange={(event) =>
                choose(sheet.students.find((s) => s.userId === event.target.value)!)
              }
            >
              {sheet.students.map((s) => (
                <option key={s.userId} value={s.userId} disabled={s.satOnline}>
                  {s.rollNumber ? `${s.rollNumber}. ` : ""}
                  {s.fullName}
                  {s.satOnline ? " (sat online)" : s.recorded ? " ✓" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sat on" htmlFor="entry-date">
            <Input
              id="entry-date"
              type="date"
              value={satOn}
              max={todayIn(new Date().toISOString())}
              onChange={(event) => setSatOn(event.target.value)}
            />
          </Field>
          <p className="ui-entry-progress tabular">
            {recordedCount} of {sheet.students.length} recorded
          </p>
        </div>

        {student.recorded && (
          <p className="ui-hint" style={{ margin: "8px 0 0" }}>
            Already recorded ({student.recorded.rawScore ?? 0} of {student.recorded.maxScore ?? 0}).
            Saving again corrects it — it does not add a second sitting.
          </p>
        )}

        <div className="ui-entry-tools">
          {letterCount > 0 && (
            <div className="ui-entry-letters">
              <Field
                label="Type the letters"
                htmlFor="entry-letters"
                hint={`${letterCount} letter questions, in order. Use - for a blank, and T or F for true/false.`}
              >
                <Input
                  id="entry-letters"
                  className="ui-card-code-input"
                  value={letters}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="BDA-C…"
                  onChange={(event) => setLetters(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      fillLetters();
                    }
                  }}
                />
              </Field>
              <Button variant="secondary" onClick={fillLetters} disabled={letters.trim() === ""}>
                Fill in
              </Button>
            </div>
          )}
          {sheetLayout.rows.length > 0 && (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void scan(file);
                }}
              />
              <Button
                variant="secondary"
                loading={busy === "scan"}
                loadingLabel="Reading the sheet…"
                onClick={() => fileRef.current?.click()}
              >
                Scan an answer sheet
              </Button>
            </div>
          )}
        </div>
      </Card>

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card title={`${student.fullName}'s answers`}>
        <ol className="ui-entry-list">
          {sheet.questions.map((question, index) => {
            const answer = draft[question.assessmentQuestionId] ?? { kind: "blank" };
            const flag = flags[question.assessmentQuestionId];
            const previous = index > 0 ? sheet.questions[index - 1] : null;
            const isAlternative =
              question.choiceGroup !== null && previous?.choiceGroup === question.choiceGroup;
            const heading =
              question.section && question.section !== (previous?.section ?? null)
                ? question.section
                : null;
            return (
              <li key={question.assessmentQuestionId} data-flag={flag ? "true" : undefined}>
                {heading && <span className="ui-entry-section">Section {heading}</span>}
                {isAlternative && <span className="ui-entry-or">OR</span>}
                <span className="ui-entry-number tabular">{question.number}</span>
                <span className="ui-entry-question">
                  <span className="ui-entry-stem">{question.stem}</span>
                  <span className="ui-hint">
                    {TYPE_HINT[question.type] ?? question.type} · {question.marks}{" "}
                    {question.marks === 1 ? "mark" : "marks"}
                  </span>
                  {flag && <span className="ui-entry-flag">⚠ {flag}</span>}
                </span>
                <span className="ui-entry-control">
                  <AnswerControl
                    question={question}
                    answer={answer}
                    onChange={(next) => set(question, next)}
                  />
                </span>
              </li>
            );
          })}
        </ol>
        <div className="ui-row" style={{ gap: 10, marginTop: 16 }}>
          <Button variant="primary" onClick={save} loading={busy === "save"} loadingLabel="Saving…">
            {student.recorded ? "Save the correction" : "Save"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function AnswerControl({
  question,
  answer,
  onChange,
}: {
  question: PaperQuestion;
  answer: DraftAnswer;
  onChange: (next: DraftAnswer) => void;
}) {
  const name = `q-${question.assessmentQuestionId}`;
  const label = `Question ${question.number}`;

  if (!question.objective) {
    const state = answer.kind === "written" ? answer.state : "blank";
    return (
      <span className="ui-entry-written">
        <Select
          aria-label={`${label}: what the student wrote`}
          value={state}
          onChange={(event) => {
            const value = event.target.value;
            onChange(
              value === "blank"
                ? { kind: "blank" }
                : {
                    kind: "written",
                    state: value as "unmarked" | "marked",
                    marks: answer.kind === "written" ? answer.marks : "",
                  },
            );
          }}
        >
          <option value="blank">Left blank</option>
          <option value="unmarked">Written — mark later</option>
          <option value="marked">Written — marks:</option>
        </Select>
        {state === "marked" && (
          <Input
            aria-label={`${label}: marks out of ${question.marks}`}
            type="number"
            inputMode="decimal"
            min={0}
            max={question.marks}
            step={0.5}
            value={answer.kind === "written" ? answer.marks : ""}
            onChange={(event) =>
              onChange({ kind: "written", state: "marked", marks: event.target.value })
            }
          />
        )}
      </span>
    );
  }

  if (question.type === "TRUE_FALSE") {
    const value = answer.kind === "boolean" ? answer.value : null;
    return (
      <fieldset className="ui-entry-choices">
        <legend className="sr-only">{label}</legend>
        {[
          { key: "T", checked: value === true, next: { kind: "boolean", value: true } as DraftAnswer },
          { key: "F", checked: value === false, next: { kind: "boolean", value: false } as DraftAnswer },
          { key: "—", checked: value === null, next: { kind: "blank" } as DraftAnswer },
        ].map((option) => (
          <label key={option.key} className="ui-entry-choice" data-checked={option.checked || undefined}>
            <input type="radio" name={name} checked={option.checked} onChange={() => onChange(option.next)} />
            <span>{option.key}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (question.optionKeys && question.optionKeys.length > 0) {
    const keys = answer.kind === "choice" ? answer.keys : [];
    const multi = question.type === "MULTI_SELECT";
    return (
      <fieldset className="ui-entry-choices">
        <legend className="sr-only">{label}</legend>
        {question.optionKeys.map((key) => (
          <label key={key} className="ui-entry-choice" data-checked={keys.includes(key) || undefined}>
            <input
              type={multi ? "checkbox" : "radio"}
              name={name}
              checked={keys.includes(key)}
              onChange={(event) => {
                const next = multi
                  ? event.target.checked
                    ? [...keys, key].sort()
                    : keys.filter((k) => k !== key)
                  : [key];
                onChange(next.length > 0 ? { kind: "choice", keys: next } : { kind: "blank" });
              }}
            />
            <span>{key}</span>
          </label>
        ))}
        {!multi && (
          <label className="ui-entry-choice" data-checked={keys.length === 0 || undefined}>
            <input type="radio" name={name} checked={keys.length === 0} onChange={() => onChange({ kind: "blank" })} />
            <span>—</span>
          </label>
        )}
      </fieldset>
    );
  }

  if (question.type === "NUMERIC") {
    return (
      <Input
        aria-label={`${label}: the number written`}
        inputMode="decimal"
        value={answer.kind === "numeric" ? answer.text : ""}
        onChange={(event) => onChange({ kind: "numeric", text: event.target.value })}
      />
    );
  }

  return (
    <Input
      aria-label={`${label}: the word written`}
      value={answer.kind === "text" ? answer.value : ""}
      onChange={(event) => onChange({ kind: "text", value: event.target.value })}
    />
  );
}
