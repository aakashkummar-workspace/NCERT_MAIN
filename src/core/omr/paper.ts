import { MAX_QUESTIONS, type OmrQuestion } from "./layout";

/**
 * Which questions of a paper go on its bubble sheet, and how each is labelled.
 *
 * Shared by the printed sheets and the scanner, for the reason `omrLayout`
 * is: the row a bubble is printed on and the row the scanner reads it as
 * must be decided in one place.
 *
 * Only what a bubble can hold: a choice among printed options, or True/False.
 * A number or a word a student writes is typed in by the teacher, and a
 * written answer is marked by one — both are listed on the sheet's footer so
 * nobody wonders where question 14 went.
 */

type SheetQuestion = {
  assessmentQuestionId: string;
  number: number;
  choiceGroup: number | null;
  type: string;
  optionKeys: string[] | null;
};

const BUBBLED = new Set(["MCQ", "ASSERTION_REASON", "MULTI_SELECT", "TRUE_FALSE"]);

export function bubbleable(question: { type: string; optionKeys: string[] | null }): boolean {
  if (!BUBBLED.has(question.type)) return false;
  return question.type === "TRUE_FALSE" || (question.optionKeys?.length ?? 0) > 0;
}

export function sheetRows(questions: SheetQuestion[]): {
  rows: OmrQuestion[];
  /** `rows[i]` is the bubble row for this question. */
  ids: string[];
  /** Printed numbers of the questions that are not on the sheet. */
  offSheet: string[];
  /** More bubble questions than one sheet holds: the rest are typed in. */
  overflow: number;
} {
  const rows: OmrQuestion[] = [];
  const ids: string[] = [];
  const offSheet: string[] = [];
  let overflow = 0;
  for (const [index, question] of questions.entries()) {
    const label = labelFor(questions, index);
    if (!bubbleable(question)) {
      offSheet.push(label);
      continue;
    }
    if (rows.length >= MAX_QUESTIONS) {
      overflow++;
      offSheet.push(label);
      continue;
    }
    rows.push({
      label,
      choices: question.type === "TRUE_FALSE" ? ["T", "F"] : question.optionKeys!,
    });
    ids.push(question.assessmentQuestionId);
  }
  return { rows, ids, offSheet, overflow };
}

/** "12", or "21a" / "21b" for the halves of an internal choice. */
export function labelFor(
  questions: { number: number; choiceGroup: number | null }[],
  index: number,
): string {
  const question = questions[index]!;
  if (question.choiceGroup === null) return String(question.number);
  const first = questions.findIndex((other) => other.choiceGroup === question.choiceGroup);
  return `${question.number}${first === index ? "a" : "b"}`;
}
