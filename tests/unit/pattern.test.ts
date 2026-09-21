import { describe, expect, it } from "vitest";
import { validateBlueprint, DEFAULT_BLUEPRINT } from "@/core/assessments/blueprint";
import {
  CBSE_PATTERNS,
  alternativesToDrop,
  answerableMarks,
  buildLayout,
  checkLayout,
  displayNumbers,
  orderBySection,
  patternForSubject,
  patternMarks,
  patternQuestionCount,
  sectionFeasibility,
  sectionFor,
  togglePair,
  validatePattern,
  type LayoutItem,
} from "@/core/assessments/pattern";

const item = (
  questionId: string,
  marks: number,
  section: string | null = null,
  choiceGroup: number | null = null,
): LayoutItem => ({ questionId, marks, section, choiceGroup });

describe("the CBSE board patterns", () => {
  it("add up to the sample papers' own figures", () => {
    // Pinned so an edit to a section count that breaks the 80 fails here.
    expect(patternMarks(CBSE_PATTERNS.MATH.sections)).toBe(80);
    expect(patternMarks(CBSE_PATTERNS.SCI.sections)).toBe(80);
    expect(patternMarks(CBSE_PATTERNS.SST.sections)).toBe(80);
    const answered = (key: keyof typeof CBSE_PATTERNS) =>
      CBSE_PATTERNS[key].sections.reduce((sum, section) => sum + section.count, 0);
    expect(answered("MATH")).toBe(38);
    expect(answered("SCI")).toBe(39);
    expect(answered("SST")).toBe(37);
  });

  it("are valid patterns", () => {
    for (const pattern of Object.values(CBSE_PATTERNS)) {
      expect(validatePattern(pattern.sections)).toEqual([]);
    }
  });

  it("are offered only to CBSE, and not for languages", () => {
    expect(patternForSubject("CBSE", "MATH")?.key).toBe("cbse-math");
    expect(patternForSubject("CBSE", "SSTHI")?.key).toBe("cbse-sst");
    expect(patternForSubject("ICSE", "MATH")).toBeNull();
    expect(patternForSubject("CBSE", "ENG")).toBeNull();
    expect(patternForSubject("CBSE", "HIN")).toBeNull();
  });

  it("counts alternatives as printed questions but not as marks", () => {
    const sections = [
      { name: "A", title: "", types: ["SA" as const], count: 4, marksEach: 3, internalChoices: 2 },
    ];
    expect(patternQuestionCount(sections)).toBe(6);
    expect(patternMarks(sections)).toBe(12);
  });
});

describe("placing a question in a section", () => {
  const sections = CBSE_PATTERNS.MATH.sections;

  it("goes by type and marks", () => {
    expect(sectionFor(sections, "MCQ", 1)).toBe("A");
    expect(sectionFor(sections, "ASSERTION_REASON", 1)).toBe("A");
    expect(sectionFor(sections, "SA", 3)).toBe("C");
    expect(sectionFor(sections, "CASE_STUDY", 4)).toBe("E");
  });

  it("places nothing where the marks do not fit, rather than somewhere wrong", () => {
    expect(sectionFor(sections, "SA", 2)).toBeNull();
    expect(sectionFor(sections, "TRUE_FALSE", 1)).toBeNull();
  });

  it("reports supply per section, counting each question once", () => {
    const supply = sectionFeasibility(sections, [
      { type: "MCQ", marks: 1, count: 30 },
      { type: "LA", marks: 5, count: 1 },
    ]);
    const byName = Object.fromEntries(supply.map((row) => [row.name, row]));
    expect(byName.A).toMatchObject({ wanted: 20, available: 30 });
    expect(byName.D).toMatchObject({ wanted: 6, available: 1 });
    expect(byName.B).toMatchObject({ wanted: 7, available: 0 });
  });
});

describe("a paper's layout", () => {
  it("orders by section and keeps the teacher's order inside each", () => {
    const sections = CBSE_PATTERNS.MATH.sections;
    const ordered = orderBySection(sections, [
      item("c1", 3, "C"),
      item("a1", 1, "A"),
      item("loose", 7, null),
      item("a2", 1, "A"),
    ]);
    expect(ordered.map((row) => row.questionId)).toEqual(["a1", "a2", "c1", "loose"]);
  });

  it("numbers an OR pair once", () => {
    expect(displayNumbers([item("a", 1), item("b", 2, null, 1), item("c", 2, null, 1), item("d", 1)])).toEqual([
      1, 2, 2, 3,
    ]);
  });

  it("counts an OR pair's marks once", () => {
    expect(answerableMarks([item("a", 1), item("b", 3, null, 1), item("c", 3, null, 1)])).toBe(4);
  });

  it("refuses alternatives with different marks", () => {
    const { errors } = checkLayout(null, [item("a", 2, null, 1), item("b", 3, null, 1)]);
    expect(errors.join(" ")).toMatch(/same marks/);
  });

  it("refuses alternatives that are not side by side", () => {
    const { errors } = checkLayout(null, [item("a", 2, null, 1), item("x", 2), item("b", 2, null, 1)]);
    expect(errors.join(" ")).toMatch(/next to each other/);
  });

  it("refuses a choice of three", () => {
    const { errors } = checkLayout(null, [
      item("a", 2, null, 1),
      item("b", 2, null, 1),
      item("c", 2, null, 1),
    ]);
    expect(errors.join(" ")).toMatch(/exactly two/);
  });

  it("warns, rather than refuses, when a section is short of the pattern", () => {
    const sections = [
      { name: "B", title: "", types: ["VSA" as const], count: 2, marksEach: 2, internalChoices: 1 },
    ];
    const result = checkLayout(sections, [item("a", 2, "B")]);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/Section B has 1 question/);
  });
});

describe("pairing in the builder", () => {
  it("pairs a question with the one below, and undoes it", () => {
    const start = [item("a", 2, "B"), item("b", 2, "B"), item("c", 2, "B")];
    const paired = togglePair(start, 0);
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(paired.items[0]!.choiceGroup).not.toBeNull();
    expect(paired.items[0]!.choiceGroup).toBe(paired.items[1]!.choiceGroup);
    expect(paired.items[2]!.choiceGroup).toBeNull();

    const undone = togglePair(paired.items, 1);
    expect(undone.ok && undone.items.every((row) => row.choiceGroup === null)).toBe(true);
  });

  it("refuses to pair across marks or sections, and says why", () => {
    const marks = togglePair([item("a", 2, "B"), item("b", 3, "B")], 0);
    expect(marks.ok).toBe(false);
    const sections = togglePair([item("a", 3, "B"), item("b", 3, "C")], 0);
    expect(sections.ok).toBe(false);
  });

  it("keeps a pair when the questions are re-saved, and pulls the halves together", () => {
    const sections = CBSE_PATTERNS.MATH.sections;
    const layout = buildLayout(
      sections,
      [
        { questionId: "b1", type: "VSA", marks: 2 },
        { questionId: "a1", type: "MCQ", marks: 1 },
        { questionId: "new", type: "VSA", marks: 2 },
        { questionId: "b2", type: "VSA", marks: 2 },
      ],
      [
        { questionId: "b1", choiceGroup: 4 },
        { questionId: "b2", choiceGroup: 4 },
      ],
    );
    expect(layout.map((row) => row.questionId)).toEqual(["a1", "b1", "b2", "new"]);
    expect(checkLayout(sections, layout).errors).toEqual([]);
  });

  it("dissolves a pair when one half is taken off the paper", () => {
    const layout = buildLayout(null, [{ questionId: "b1", type: "VSA", marks: 2 }], [
      { questionId: "b1", choiceGroup: 1 },
      { questionId: "b2", choiceGroup: 1 },
    ]);
    expect(layout[0]!.choiceGroup).toBeNull();
  });
});

describe("which alternative counts", () => {
  it("is the one the student answered", () => {
    expect(
      alternativesToDrop([
        { position: 5, choiceGroup: 1, answered: false },
        { position: 6, choiceGroup: 1, answered: true },
      ]),
    ).toEqual([5]);
  });

  it("is the first in paper order when both were answered", () => {
    // CBSE's instruction to examiners, and the rule that cannot be gamed.
    expect(
      alternativesToDrop([
        { position: 6, choiceGroup: 1, answered: true },
        { position: 5, choiceGroup: 1, answered: true },
      ]),
    ).toEqual([6]);
  });

  it("is the first when neither was, so one blank remains to be counted", () => {
    expect(
      alternativesToDrop([
        { position: 5, choiceGroup: 1, answered: false },
        { position: 6, choiceGroup: 1, answered: false },
        { position: 7, choiceGroup: null, answered: false },
      ]),
    ).toEqual([6]);
  });
});

describe("a blueprint under a pattern", () => {
  it("needs no type mix, and holds the marks to the sections", () => {
    const pattern = CBSE_PATTERNS.MATH;
    const ok = validateBlueprint({
      ...DEFAULT_BLUEPRINT,
      typeMix: {},
      totalMarks: 80,
      totalQuestions: patternQuestionCount(pattern.sections),
      pattern: { key: pattern.key, label: pattern.label, sections: pattern.sections },
    });
    expect(ok.filter((problem) => problem.severity === "error")).toEqual([]);

    const wrong = validateBlueprint({
      ...DEFAULT_BLUEPRINT,
      typeMix: {},
      totalMarks: 60,
      totalQuestions: patternQuestionCount(pattern.sections),
      pattern: { key: pattern.key, label: pattern.label, sections: pattern.sections },
    });
    expect(wrong.some((problem) => problem.field === "totalMarks")).toBe(true);
  });
});
