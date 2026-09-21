/**
 * The recording form's state, as pure functions — so typing letters, scanning
 * a sheet and loading a recorded sitting all fill the SAME draft, and turning
 * that draft into what the server records is one function the tests can hold.
 */
import type { PaperEntry as Entry, PaperQuestion } from "@/core/paper";

export type DraftAnswer =
  | { kind: "choice"; keys: string[] }
  | { kind: "boolean"; value: boolean }
  | { kind: "numeric"; text: string }
  | { kind: "text"; value: string }
  | { kind: "written"; state: "unmarked" | "marked"; marks: string }
  | { kind: "blank" };

export type Draft = Record<string, DraftAnswer>;

/** Single-answer questions a letter can answer, in paper order. */
export function letterQuestions(questions: PaperQuestion[]): PaperQuestion[] {
  return questions.filter(
    (question) =>
      question.type === "MCQ" ||
      question.type === "ASSERTION_REASON" ||
      question.type === "TRUE_FALSE",
  );
}

/**
 * Fill the draft from a string of letters: "BDA-C" answers the first five
 * letter questions, and "-" (or ".") leaves one blank. The fastest way to
 * copy a stack of sheets by hand, and each letter is checked against that
 * question's own options so a slip is caught at the letter, not at the end.
 */
export function applyLetters(
  questions: PaperQuestion[],
  draft: Draft,
  letters: string,
): { draft: Draft; problems: string[] } {
  const targets = letterQuestions(questions);
  const cleaned = letters.toUpperCase().replace(/\s+/g, "");
  const next: Draft = { ...draft };
  const problems: string[] = [];
  if (cleaned.length > targets.length) {
    problems.push(
      `That is ${cleaned.length} letters and the paper has ${targets.length} letter questions.`,
    );
  }
  [...cleaned].slice(0, targets.length).forEach((letter, index) => {
    const question = targets[index]!;
    const label = `Question ${question.number}`;
    if (letter === "-" || letter === ".") {
      next[question.assessmentQuestionId] = { kind: "blank" };
      return;
    }
    if (question.type === "TRUE_FALSE") {
      if (letter === "T" || letter === "F") {
        next[question.assessmentQuestionId] = { kind: "boolean", value: letter === "T" };
      } else {
        problems.push(`${label} is true/false, so T or F — not ${letter}.`);
      }
      return;
    }
    if ((question.optionKeys ?? []).includes(letter)) {
      next[question.assessmentQuestionId] = { kind: "choice", keys: [letter] };
    } else {
      problems.push(`${label} has no option ${letter}.`);
    }
  });
  return { draft: next, problems };
}

export function draftFromEntries(entries: Entry[]): Draft {
  const draft: Draft = {};
  for (const entry of entries) {
    switch (entry.kind) {
      case "choice":
        draft[entry.assessmentQuestionId] = { kind: "choice", keys: entry.keys };
        break;
      case "boolean":
        draft[entry.assessmentQuestionId] = { kind: "boolean", value: entry.value };
        break;
      case "numeric":
        draft[entry.assessmentQuestionId] = { kind: "numeric", text: String(entry.value) };
        break;
      case "text":
        draft[entry.assessmentQuestionId] = { kind: "text", value: entry.value };
        break;
      case "written":
        draft[entry.assessmentQuestionId] =
          entry.marks === null
            ? { kind: "written", state: "unmarked", marks: "" }
            : { kind: "written", state: "marked", marks: String(entry.marks) };
        break;
      default:
        draft[entry.assessmentQuestionId] = { kind: "blank" };
    }
  }
  return draft;
}

/**
 * The draft as the server records it, or the first problem that stops it.
 * An untouched question is blank, never a guess.
 */
export function entriesFromDraft(
  questions: PaperQuestion[],
  draft: Draft,
): { ok: true; entries: Entry[] } | { ok: false; message: string } {
  const entries: Entry[] = [];
  for (const question of questions) {
    const id = question.assessmentQuestionId;
    const answer = draft[id] ?? { kind: "blank" };
    switch (answer.kind) {
      case "blank":
        entries.push({ assessmentQuestionId: id, kind: "blank" });
        break;
      case "choice":
        entries.push(
          answer.keys.length === 0
            ? { assessmentQuestionId: id, kind: "blank" }
            : { assessmentQuestionId: id, kind: "choice", keys: answer.keys },
        );
        break;
      case "boolean":
        entries.push({ assessmentQuestionId: id, kind: "boolean", value: answer.value });
        break;
      case "numeric": {
        if (answer.text.trim() === "") {
          entries.push({ assessmentQuestionId: id, kind: "blank" });
          break;
        }
        const value = Number(answer.text.trim().replace(/,/g, ""));
        if (!Number.isFinite(value)) {
          return { ok: false, message: `Question ${question.number}: "${answer.text}" is not a number.` };
        }
        entries.push({ assessmentQuestionId: id, kind: "numeric", value });
        break;
      }
      case "text":
        entries.push(
          answer.value.trim() === ""
            ? { assessmentQuestionId: id, kind: "blank" }
            : { assessmentQuestionId: id, kind: "text", value: answer.value.trim() },
        );
        break;
      case "written": {
        if (answer.state === "unmarked") {
          entries.push({ assessmentQuestionId: id, kind: "written", marks: null });
          break;
        }
        const marks = Number(answer.marks);
        if (answer.marks.trim() === "" || !Number.isFinite(marks)) {
          return { ok: false, message: `Question ${question.number}: give a mark, or choose "not marked yet".` };
        }
        if (marks < 0 || marks > question.marks) {
          return { ok: false, message: `Question ${question.number} is out of ${question.marks}.` };
        }
        entries.push({ assessmentQuestionId: id, kind: "written", marks });
        break;
      }
    }
  }
  return { ok: true, entries };
}
