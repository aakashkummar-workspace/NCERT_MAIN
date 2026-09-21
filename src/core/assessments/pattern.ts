/**
 * Sections and internal choice: the shape of a CBSE board paper.
 *
 * Pure — the builder runs it live, the server runs it again at save and at
 * publish, and the player, the printout and the paper-marks screen all number
 * questions through `displayNumbers`, so a question is Q21 everywhere.
 *
 * ---------------------------------------------------------------------------
 * Why a pattern is not the blueprint's type mix
 * ---------------------------------------------------------------------------
 * A teacher preparing a class for boards does not think "40% multiple choice".
 * They think "Section A, twenty one-markers; Section B, five two-markers with
 * an internal choice in two". The percentages were the wrong vocabulary, and
 * the paper they produced had no sections and no "OR" — so it did not look
 * like, or practise, the paper the class will sit in March.
 *
 * So a pattern names SECTIONS: which question types each takes, how many a
 * student answers, the marks each carries, and how many of those carry an
 * internal choice. Feasibility is answered per section — "Section D wants 6
 * long answers (4 plus 2 alternatives) and the bank has 1" — because that is
 * the sentence a teacher can act on.
 *
 * ---------------------------------------------------------------------------
 * Internal choice
 * ---------------------------------------------------------------------------
 * Two questions sharing a `choiceGroup` are alternatives: the student answers
 * one. They must sit side by side, in the same section, worth the same marks —
 * an "OR" between a two-marker and a three-marker is a paper whose total
 * depends on which the student picked. The pair counts ONCE towards the total
 * and shares one question number.
 *
 * When both are answered, the first in paper order is the one that counts.
 * That is CBSE's own instruction to examiners ("marks obtained in the question
 * attempted first shall be retained"), and it is the rule that cannot be gamed:
 * "the better of the two" would reward answering both.
 */

import type { QuestionType } from "@/core/questions/validate";

export type SectionPlan = {
  /** "A", "B" … — printed as "Section A". */
  name: string;
  title: string;
  types: QuestionType[];
  /** Questions a student answers in this section. */
  count: number;
  marksEach: number;
  /** How many of those questions carry an "OR" alternative. */
  internalChoices: number;
};

export type PaperPattern = {
  key: string;
  label: string;
  durationMinutes: number;
  sections: SectionPlan[];
};

const OBJECTIVE: QuestionType[] = ["MCQ", "ASSERTION_REASON"];

/**
 * The CBSE Class 10 board pattern (2025–26 sample papers), which most schools
 * also use for Class 9. Figures are the sample papers' own: Maths 38
 * questions, Science 39, Social Science 37, all 80 marks in three hours.
 * A school's pre-boards follow these, which is the whole reason to offer them.
 */
export const CBSE_PATTERNS: Record<"MATH" | "SCI" | "SST", PaperPattern> = {
  MATH: {
    key: "cbse-math",
    label: "CBSE board pattern — Mathematics",
    durationMinutes: 180,
    sections: [
      { name: "A", title: "Multiple choice and assertion–reason", types: OBJECTIVE, count: 20, marksEach: 1, internalChoices: 0 },
      { name: "B", title: "Very short answer", types: ["VSA"], count: 5, marksEach: 2, internalChoices: 2 },
      { name: "C", title: "Short answer", types: ["SA"], count: 6, marksEach: 3, internalChoices: 2 },
      { name: "D", title: "Long answer", types: ["LA"], count: 4, marksEach: 5, internalChoices: 2 },
      { name: "E", title: "Case-based", types: ["CASE_STUDY"], count: 3, marksEach: 4, internalChoices: 0 },
    ],
  },
  SCI: {
    key: "cbse-science",
    label: "CBSE board pattern — Science",
    durationMinutes: 180,
    sections: [
      { name: "A", title: "Multiple choice and assertion–reason", types: OBJECTIVE, count: 20, marksEach: 1, internalChoices: 0 },
      { name: "B", title: "Very short answer", types: ["VSA"], count: 6, marksEach: 2, internalChoices: 2 },
      { name: "C", title: "Short answer", types: ["SA"], count: 7, marksEach: 3, internalChoices: 2 },
      { name: "D", title: "Long answer", types: ["LA"], count: 3, marksEach: 5, internalChoices: 3 },
      { name: "E", title: "Case-based", types: ["CASE_STUDY"], count: 3, marksEach: 4, internalChoices: 0 },
    ],
  },
  SST: {
    key: "cbse-sst",
    label: "CBSE board pattern — Social Science",
    durationMinutes: 180,
    sections: [
      { name: "A", title: "Multiple choice and assertion–reason", types: OBJECTIVE, count: 20, marksEach: 1, internalChoices: 0 },
      { name: "B", title: "Very short answer", types: ["VSA"], count: 4, marksEach: 2, internalChoices: 1 },
      { name: "C", title: "Short answer", types: ["SA"], count: 5, marksEach: 3, internalChoices: 2 },
      { name: "D", title: "Long answer", types: ["LA"], count: 4, marksEach: 5, internalChoices: 4 },
      { name: "E", title: "Case-based", types: ["CASE_STUDY"], count: 3, marksEach: 4, internalChoices: 0 },
      // The map question is 5 marks of locating and labelling; the bank has no
      // map type, so it is filed as a long answer and says so in its title.
      { name: "F", title: "Map skill (filed as a 5-mark long answer)", types: ["LA"], count: 1, marksEach: 5, internalChoices: 0 },
    ],
  },
};

/**
 * The board pattern for a subject, or null where there is none to offer.
 *
 * CBSE only: an ICSE paper has a different shape, and offering the CBSE one to
 * an ICSE school would be the builder confidently teaching the wrong exam.
 * English and Hindi are left out too — their papers are built around reading
 * passages and writing tasks, which a section of "types" cannot describe.
 */
export function patternForSubject(boardCode: string, subjectCode: string): PaperPattern | null {
  if (boardCode !== "CBSE") return null;
  if (subjectCode === "MATH") return CBSE_PATTERNS.MATH;
  if (subjectCode === "SCI") return CBSE_PATTERNS.SCI;
  if (subjectCode === "SST" || subjectCode.startsWith("SST")) return CBSE_PATTERNS.SST;
  return null;
}

/** Marks a student can score: every section's answered questions. */
export function patternMarks(sections: SectionPlan[]): number {
  return sections.reduce((sum, section) => sum + section.count * section.marksEach, 0);
}

/** Questions printed on the paper, alternatives included. */
export function patternQuestionCount(sections: SectionPlan[]): number {
  return sections.reduce((sum, section) => sum + section.count + section.internalChoices, 0);
}

export type PatternProblem = { section: string | null; message: string };

export function validatePattern(sections: SectionPlan[]): PatternProblem[] {
  const problems: PatternProblem[] = [];
  if (sections.length === 0) {
    problems.push({ section: null, message: "A pattern needs at least one section." });
  }
  const names = new Set<string>();
  for (const section of sections) {
    if (names.has(section.name)) {
      problems.push({ section: section.name, message: `There are two sections called ${section.name}.` });
    }
    names.add(section.name);
    if (section.types.length === 0) {
      problems.push({ section: section.name, message: `Section ${section.name} takes no question type.` });
    }
    if (!Number.isInteger(section.count) || section.count < 1) {
      problems.push({ section: section.name, message: `Section ${section.name} needs at least one question.` });
    }
    if (!Number.isInteger(section.marksEach) || section.marksEach < 1) {
      problems.push({ section: section.name, message: `Each question in Section ${section.name} must carry at least one mark.` });
    }
    if (
      !Number.isInteger(section.internalChoices) ||
      section.internalChoices < 0 ||
      section.internalChoices > section.count
    ) {
      problems.push({
        section: section.name,
        message: `Section ${section.name} has ${section.count} questions, so it can have between 0 and ${section.count} internal choices.`,
      });
    }
  }
  const total = patternQuestionCount(sections);
  if (total > 100) {
    problems.push({ section: null, message: `That is ${total} questions on one paper, and the limit is 100.` });
  }
  const marks = patternMarks(sections);
  if (marks > 200) {
    problems.push({ section: null, message: `That is ${marks} marks, and the limit is 200.` });
  }
  return problems;
}

/**
 * Which section a question belongs in: the first whose types include it and
 * whose marks match. Marks matter — a 3-mark SA dropped into a 2-mark section
 * would break the section's total, so it goes nowhere instead of somewhere
 * wrong.
 */
export function sectionFor(
  sections: SectionPlan[],
  type: QuestionType,
  marks: number,
): string | null {
  return (
    sections.find((section) => section.types.includes(type) && section.marksEach === marks)?.name ??
    null
  );
}

export type SectionSupply = {
  name: string;
  title: string;
  /** Questions the section prints: answered plus alternatives. */
  wanted: number;
  available: number;
};

/** Per section: what the pattern prints against what the bank holds. */
export function sectionFeasibility(
  sections: SectionPlan[],
  bank: { type: QuestionType; marks: number; count: number }[],
): SectionSupply[] {
  // A question is counted towards the first section that would take it, the
  // same rule `sectionFor` places it by — two sections must not both claim it.
  const available = new Map<string, number>();
  for (const row of bank) {
    const name = sectionFor(sections, row.type, row.marks);
    if (name) available.set(name, (available.get(name) ?? 0) + row.count);
  }
  return sections.map((section) => ({
    name: section.name,
    title: section.title,
    wanted: section.count + section.internalChoices,
    available: available.get(section.name) ?? 0,
  }));
}

export function describeSectionShortfalls(supply: SectionSupply[]): string[] {
  return supply
    .filter((row) => row.available < row.wanted)
    .map((row) =>
      row.available === 0
        ? `Section ${row.name} (${row.title.toLowerCase()}) needs ${row.wanted} questions and the bank has none that fit. Write them, or change the section.`
        : `Section ${row.name} (${row.title.toLowerCase()}) needs ${row.wanted} questions and the bank has ${row.available}. Write ${row.wanted - row.available} more, or change the section.`,
    );
}

// ---------------------------------------------------------------------------
// A paper's layout: sections and "OR" pairs on the chosen questions
// ---------------------------------------------------------------------------

export type LayoutItem = {
  questionId: string;
  marks: number;
  section: string | null;
  choiceGroup: number | null;
};

export type Layout<T extends LayoutItem = LayoutItem> = T[];

/**
 * Order by section, keeping the teacher's order inside each, with unsectioned
 * questions last. Stable, so saving twice does not reshuffle.
 */
export function orderBySection<T extends LayoutItem>(sections: SectionPlan[], items: T[]): T[] {
  const rank = new Map(sections.map((section, index) => [section.name, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (rank.get(a.item.section ?? "") ?? sections.length) -
          (rank.get(b.item.section ?? "") ?? sections.length) || a.index - b.index,
    )
    .map(({ item }) => item);
}

/**
 * What is wrong with a layout, as sentences. Errors are what the server
 * refuses to save; warnings are a pattern not quite met, which a teacher may
 * well intend and is told about rather than stopped.
 */
export function checkLayout(
  sections: SectionPlan[] | null,
  items: LayoutItem[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const groups = new Map<number, number[]>();
  items.forEach((item, index) => {
    if (item.choiceGroup === null) return;
    const list = groups.get(item.choiceGroup) ?? [];
    list.push(index);
    groups.set(item.choiceGroup, list);
  });

  for (const [, indexes] of groups) {
    const first = items[indexes[0]!]!;
    const number = displayNumbers(items)[indexes[0]!];
    if (indexes.length !== 2) {
      errors.push(`Question ${number} has ${indexes.length} alternatives. An internal choice is exactly two questions.`);
      continue;
    }
    const second = items[indexes[1]!]!;
    if (indexes[1]! !== indexes[0]! + 1) {
      errors.push(`The two alternatives for question ${number} must sit next to each other.`);
    }
    if (first.marks !== second.marks) {
      errors.push(
        `Question ${number} offers a ${first.marks}-mark question OR a ${second.marks}-mark one, so the total would depend on which a student picked. Alternatives must carry the same marks.`,
      );
    }
    if (first.section !== second.section) {
      errors.push(`The two alternatives for question ${number} are in different sections.`);
    }
  }

  if (sections) {
    for (const section of sections) {
      const inSection = items.filter((item) => item.section === section.name);
      const choices = new Set(
        inSection.flatMap((item) => (item.choiceGroup === null ? [] : [item.choiceGroup])),
      ).size;
      const answered = inSection.length - choices;
      if (answered !== section.count) {
        warnings.push(
          `Section ${section.name} has ${answered} ${answered === 1 ? "question" : "questions"} to answer; the pattern has ${section.count}.`,
        );
      }
      if (choices !== section.internalChoices) {
        warnings.push(
          `Section ${section.name} has ${choices} internal ${choices === 1 ? "choice" : "choices"}; the pattern has ${section.internalChoices}.`,
        );
      }
      const wrongMarks = inSection.filter((item) => item.marks !== section.marksEach).length;
      if (wrongMarks > 0) {
        warnings.push(
          `${wrongMarks} ${wrongMarks === 1 ? "question" : "questions"} in Section ${section.name} ${wrongMarks === 1 ? "is" : "are"} not worth ${section.marksEach} ${section.marksEach === 1 ? "mark" : "marks"}.`,
        );
      }
    }
    const loose = items.filter((item) => item.section === null).length;
    if (loose > 0) {
      warnings.push(
        `${loose} ${loose === 1 ? "question fits" : "questions fit"} no section of this pattern and will print after the last one.`,
      );
    }
  }

  return { errors, warnings };
}

/**
 * The marks a student can score: an "OR" pair counts once. This is the figure
 * that must equal the paper's total, and summing every row — what the builder
 * did before choices existed — would count every alternative twice.
 */
export function answerableMarks(items: { marks: number; choiceGroup: number | null }[]): number {
  const seen = new Set<number>();
  let total = 0;
  for (const item of items) {
    if (item.choiceGroup !== null) {
      if (seen.has(item.choiceGroup)) continue;
      seen.add(item.choiceGroup);
    }
    total += item.marks;
  }
  return total;
}

/**
 * The number printed beside each question, in paper order. Alternatives share
 * one — a board paper reads "21. … OR …", not "21. … 22. …".
 */
export function displayNumbers(items: { choiceGroup: number | null }[]): number[] {
  const numbers: number[] = [];
  let current = 0;
  let previousGroup: number | null = null;
  for (const item of items) {
    if (item.choiceGroup !== null && item.choiceGroup === previousGroup) {
      numbers.push(current);
    } else {
      current++;
      numbers.push(current);
    }
    previousGroup = item.choiceGroup;
  }
  return numbers;
}

/**
 * Of an "OR" pair, which answer counts: the first in paper order that was
 * answered, or the first if neither was. Returns the positions to DROP.
 *
 * Dropping, rather than scoring zero, is the point: the alternative a student
 * did not take is neither a blank (a mistake in their bank, a zero in their
 * evidence) nor a mark. It was never theirs to answer.
 */
export function alternativesToDrop(
  rows: { position: number; choiceGroup: number | null; answered: boolean }[],
): number[] {
  const byGroup = new Map<number, typeof rows>();
  for (const row of rows) {
    if (row.choiceGroup === null) continue;
    const list = byGroup.get(row.choiceGroup) ?? [];
    list.push(row);
    byGroup.set(row.choiceGroup, list);
  }
  const drop: number[] = [];
  for (const [, group] of byGroup) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => a.position - b.position);
    const kept = ordered.find((row) => row.answered) ?? ordered[0]!;
    for (const row of ordered) if (row !== kept) drop.push(row.position);
  }
  return drop;
}

/**
 * The layout for the questions a teacher has ticked, keeping the "OR" pairs
 * they made before.
 *
 * Shared by the builder (to show the paper as it will be saved) and nothing
 * else needs to repeat it: the server re-orders by the same `orderBySection`,
 * which is stable, so what the builder shows is what is stored.
 *
 * A pair survives only if both halves are still on the paper, in the same
 * section, at the same marks — otherwise it quietly stops being a pair rather
 * than failing the save, because un-ticking one half is an ordinary edit. The
 * second half is then moved to sit directly under the first.
 */
export function buildLayout(
  sections: SectionPlan[] | null,
  chosen: { questionId: string; type: QuestionType; marks: number }[],
  previous: { questionId: string; choiceGroup: number | null }[],
): LayoutItem[] {
  const previousGroup = new Map(previous.map((item) => [item.questionId, item.choiceGroup]));
  const items: LayoutItem[] = chosen.map((question) => ({
    questionId: question.questionId,
    marks: question.marks,
    section: sections ? sectionFor(sections, question.type, question.marks) : null,
    choiceGroup: previousGroup.get(question.questionId) ?? null,
  }));

  const members = new Map<number, LayoutItem[]>();
  for (const item of items) {
    if (item.choiceGroup === null) continue;
    members.set(item.choiceGroup, [...(members.get(item.choiceGroup) ?? []), item]);
  }
  for (const [, group] of members) {
    const valid =
      group.length === 2 &&
      group[0]!.section === group[1]!.section &&
      group[0]!.marks === group[1]!.marks;
    if (!valid) for (const item of group) item.choiceGroup = null;
  }

  const ordered = sections ? orderBySection(sections, items) : items;
  const result: LayoutItem[] = [];
  const placed = new Set<string>();
  for (const item of ordered) {
    if (placed.has(item.questionId)) continue;
    result.push(item);
    placed.add(item.questionId);
    if (item.choiceGroup !== null) {
      const partner = ordered.find(
        (other) => other.choiceGroup === item.choiceGroup && other.questionId !== item.questionId,
      );
      if (partner && !placed.has(partner.questionId)) {
        result.push(partner);
        placed.add(partner.questionId);
      }
    }
  }
  return result;
}

/**
 * Make question `index` and the one after it an "OR" pair, or undo the pair
 * `index` belongs to. Refuses — with the reason — rather than making a pair
 * the save would reject.
 */
export function togglePair(
  items: LayoutItem[],
  index: number,
): { ok: true; items: LayoutItem[] } | { ok: false; message: string } {
  const item = items[index];
  if (!item) return { ok: false, message: "There is no question there." };

  if (item.choiceGroup !== null) {
    const group = item.choiceGroup;
    return {
      ok: true,
      items: items.map((other) =>
        other.choiceGroup === group ? { ...other, choiceGroup: null } : other,
      ),
    };
  }

  const next = items[index + 1];
  if (!next) return { ok: false, message: "The last question has nothing after it to pair with." };
  if (next.choiceGroup !== null) {
    return { ok: false, message: "The next question is already half of another choice." };
  }
  if (next.section !== item.section) {
    return { ok: false, message: "Alternatives must be in the same section." };
  }
  if (next.marks !== item.marks) {
    return {
      ok: false,
      message: `These carry ${item.marks} and ${next.marks} marks. Alternatives must carry the same marks, or the total would depend on which one a student picked.`,
    };
  }
  const group = Math.max(0, ...items.map((other) => other.choiceGroup ?? 0)) + 1;
  return {
    ok: true,
    items: items.map((other, position) =>
      position === index || position === index + 1 ? { ...other, choiceGroup: group } : other,
    ),
  };
}
