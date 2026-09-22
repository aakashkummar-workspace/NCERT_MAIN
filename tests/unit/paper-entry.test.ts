import { describe, expect, it } from "vitest";
import type { PaperQuestion } from "@/core/paper";
import {
  applyLetters,
  draftFromEntries,
  entriesFromDraft,
} from "@/app/teacher/assignments/[id]/paper/entry";
import { labelFor, sheetRows } from "@/core/omr/paper";

const q = (
  id: string,
  number: number,
  type: PaperQuestion["type"],
  extra: Partial<PaperQuestion> = {},
): PaperQuestion => ({
  assessmentQuestionId: id,
  position: number,
  number,
  section: null,
  choiceGroup: null,
  type,
  marks: 1,
  objective: !["VSA", "SA", "LA", "CASE_STUDY"].includes(type),
  optionKeys: ["MCQ", "ASSERTION_REASON", "MULTI_SELECT"].includes(type) ? ["A", "B", "C", "D"] : null,
  stem: "",
  ...extra,
});

const paper = [
  q("q1", 1, "MCQ"),
  q("q2", 2, "TRUE_FALSE"),
  q("q3", 3, "NUMERIC"),
  q("q4", 4, "MCQ"),
  q("q5", 5, "SA", { marks: 3 }),
];

describe("typing the letters", () => {
  it("fills the letter questions in order and skips the rest", () => {
    const { draft, problems } = applyLetters(paper, {}, "b t -");
    expect(problems).toEqual([]);
    expect(draft.q1).toEqual({ kind: "choice", keys: ["B"] });
    expect(draft.q2).toEqual({ kind: "boolean", value: true });
    expect(draft.q4).toEqual({ kind: "blank" });
    expect(draft.q3).toBeUndefined();
  });

  it("catches a letter the question does not have, at that question", () => {
    const { problems } = applyLetters(paper, {}, "EX");
    expect(problems.join(" ")).toMatch(/Question 1 has no option E/);
    expect(problems.join(" ")).toMatch(/Question 2 is true\/false/);
  });

  it("says when there are more letters than questions", () => {
    const { problems } = applyLetters(paper, {}, "ABCD");
    expect(problems.join(" ")).toMatch(/3 letter questions/);
  });
});

describe("turning the form into a record", () => {
  it("records an untouched question as blank, never a guess", () => {
    const built = entriesFromDraft(paper, {});
    expect(built.ok && built.entries.every((entry) => entry.kind === "blank")).toBe(true);
  });

  it("refuses a written mark above the question's marks", () => {
    const built = entriesFromDraft(paper, {
      q5: { kind: "written", state: "marked", marks: "4" },
    });
    expect(built.ok).toBe(false);
  });

  it("keeps 'written, mark later' distinct from a blank", () => {
    const built = entriesFromDraft(paper, { q5: { kind: "written", state: "unmarked", marks: "" } });
    expect(built.ok && built.entries.find((e) => e.assessmentQuestionId === "q5")).toEqual({
      assessmentQuestionId: "q5",
      kind: "written",
      marks: null,
    });
  });

  it("round-trips a recorded sitting back into the form", () => {
    const built = entriesFromDraft(paper, {
      q1: { kind: "choice", keys: ["C"] },
      q3: { kind: "numeric", text: "12.5" },
      q5: { kind: "written", state: "marked", marks: "2.5" },
    });
    if (!built.ok) throw new Error(built.message);
    const again = entriesFromDraft(paper, draftFromEntries(built.entries));
    expect(again).toEqual(built);
  });
});

describe("the bubble sheet's rows", () => {
  it("holds only what a bubble can hold, and names the rest", () => {
    const { rows, ids, offSheet } = sheetRows(paper);
    expect(ids).toEqual(["q1", "q2", "q4"]);
    expect(rows[1]!.choices).toEqual(["T", "F"]);
    expect(offSheet).toEqual(["3", "5"]);
  });

  it("labels the halves of an internal choice", () => {
    const pair = [
      q("a", 1, "MCQ"),
      q("b", 2, "MCQ", { choiceGroup: 1 }),
      q("c", 2, "MCQ", { choiceGroup: 1 }),
    ];
    expect(pair.map((_, index) => labelFor(pair, index))).toEqual(["1", "2a", "2b"]);
  });
});
