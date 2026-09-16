/**
 * The blueprint: what a teacher says the paper should contain, and whether the
 * bank can actually supply it.
 *
 * Pure — no database — so the builder validates live while a teacher is still
 * choosing, and the server checks the same thing again at publish.
 *
 * ---------------------------------------------------------------------------
 * Why feasibility is the interesting half
 * ---------------------------------------------------------------------------
 * Checking that percentages sum to 100 is arithmetic. The check that earns its
 * place is the other one: *you have asked for 6 hard questions on Similarity
 * and the bank holds 2*. Told at step 3, that is a decision — write four more,
 * or lower the difficulty. Discovered at step 5, it is a wasted evening.
 *
 * So a shortfall is never a silent truncation and never a substitution. It is
 * reported, with the number, before anything is assembled.
 */

import type { QuestionType } from "@/core/questions/validate";

export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export type Blueprint = {
  totalQuestions: number;
  totalMarks: number;
  /** Percentages. Must sum to 100. */
  difficultyMix: Record<Difficulty, number>;
  /** Percentages by type. Must sum to 100. */
  typeMix: Partial<Record<QuestionType, number>>;
  /** The curriculum scope: which outcomes the paper may draw on. */
  outcomeIds: string[];
};

export type BlueprintProblem = {
  severity: "error" | "warning";
  field: "totalQuestions" | "totalMarks" | "difficultyMix" | "typeMix" | "scope";
  message: string;
};

/** One row of what the bank actually holds, within the chosen scope. */
export type BankInventory = {
  difficulty: Difficulty;
  type: QuestionType;
  count: number;
};

/** What the blueprint asks for, slot by slot. */
export type Slot = {
  difficulty: Difficulty;
  type: QuestionType;
  wanted: number;
  available: number;
};

export type Feasibility = {
  slots: Slot[];
  /** Total questions the bank can supply against this blueprint. */
  supplied: number;
  /** Total the blueprint asked for. */
  wanted: number;
  shortfalls: Slot[];
  feasible: boolean;
};

export const DEFAULT_BLUEPRINT: Blueprint = {
  totalQuestions: 20,
  totalMarks: 20,
  // The CBSE-ish default shape a teacher will recognise, so the first screen
  // is already close to what they wanted.
  difficultyMix: { EASY: 30, MEDIUM: 50, HARD: 20 },
  typeMix: { MCQ: 100 },
  outcomeIds: [],
};

export function validateBlueprint(blueprint: Blueprint): BlueprintProblem[] {
  const problems: BlueprintProblem[] = [];
  const error = (field: BlueprintProblem["field"], message: string) =>
    problems.push({ severity: "error", field, message });
  const warn = (field: BlueprintProblem["field"], message: string) =>
    problems.push({ severity: "warning", field, message });

  if (!Number.isInteger(blueprint.totalQuestions) || blueprint.totalQuestions < 1) {
    error("totalQuestions", "A paper needs at least one question.");
  } else if (blueprint.totalQuestions > 100) {
    error("totalQuestions", "More than 100 questions is not a class test.");
  }

  if (!Number.isInteger(blueprint.totalMarks) || blueprint.totalMarks < 1) {
    error("totalMarks", "Total marks must be a whole number, at least 1.");
  } else if (blueprint.totalMarks > 200) {
    error("totalMarks", "More than 200 marks is not a class test.");
  }

  // Marks must be reachable with whole-mark questions.
  if (
    Number.isInteger(blueprint.totalQuestions) &&
    Number.isInteger(blueprint.totalMarks) &&
    blueprint.totalQuestions > 0 &&
    blueprint.totalMarks > 0 &&
    blueprint.totalMarks < blueprint.totalQuestions
  ) {
    error(
      "totalMarks",
      `${blueprint.totalQuestions} questions cannot total ${blueprint.totalMarks} marks — every question is worth at least 1.`,
    );
  }

  const difficultySum = sum(Object.values(blueprint.difficultyMix));
  if (difficultySum !== 100) {
    error(
      "difficultyMix",
      `The difficulty split adds up to ${difficultySum}%, not 100%.`,
    );
  }

  const typeValues = Object.values(blueprint.typeMix).filter(
    (value): value is number => typeof value === "number",
  );
  const typeSum = sum(typeValues);
  if (typeValues.length === 0) {
    error("typeMix", "Choose at least one question type.");
  } else if (typeSum !== 100) {
    error("typeMix", `The question-type split adds up to ${typeSum}%, not 100%.`);
  }

  if (blueprint.outcomeIds.length === 0) {
    // Not an error: a teacher may want a mixed revision paper. But a paper
    // scoped to nothing cannot tell them which concepts the class has secured.
    warn(
      "scope",
      "No learning outcomes chosen, so the results will show scores but not which concepts the class has secured.",
    );
  }

  return problems;
}

/**
 * Turn percentages into whole question counts.
 *
 * Percentages rarely divide evenly, so the remainder has to land somewhere.
 * It goes to the LARGEST shares first — a 30/50/20 split over 7 questions
 * becomes 2/4/1 rather than 2/3/1 plus a lost question. A blueprint that
 * quietly returns fewer questions than it promised is worse than one that
 * rounds visibly.
 */
export function allocate(
  total: number,
  mix: Record<string, number>,
): Record<string, number> {
  const keys = Object.keys(mix).filter((key) => (mix[key] ?? 0) > 0);
  if (keys.length === 0 || total <= 0) return {};

  const exact = keys.map((key) => ({
    key,
    value: (total * (mix[key] ?? 0)) / 100,
  }));

  const counts: Record<string, number> = {};
  let assigned = 0;
  for (const { key, value } of exact) {
    counts[key] = Math.floor(value);
    assigned += counts[key]!;
  }

  const remainders = exact
    .map(({ key, value }) => ({ key, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);

  let leftover = total - assigned;
  let index = 0;
  while (leftover > 0 && remainders.length > 0) {
    const key = remainders[index % remainders.length]!.key;
    counts[key] = (counts[key] ?? 0) + 1;
    leftover--;
    index++;
  }

  return counts;
}

/**
 * What the blueprint asks for, slot by slot, against what the bank holds.
 */
export function planSlots(
  blueprint: Blueprint,
  inventory: BankInventory[],
): Feasibility {
  const byDifficulty = allocate(blueprint.totalQuestions, blueprint.difficultyMix);

  const available = new Map<string, number>();
  for (const row of inventory) {
    const key = `${row.difficulty}:${row.type}`;
    available.set(key, (available.get(key) ?? 0) + row.count);
  }

  const slots: Slot[] = [];

  for (const [difficulty, countForDifficulty] of Object.entries(byDifficulty)) {
    if (countForDifficulty <= 0) continue;
    const byType = allocate(
      countForDifficulty,
      blueprint.typeMix as Record<string, number>,
    );

    for (const [type, wanted] of Object.entries(byType)) {
      if (wanted <= 0) continue;
      slots.push({
        difficulty: difficulty as Difficulty,
        type: type as QuestionType,
        wanted,
        available: available.get(`${difficulty}:${type}`) ?? 0,
      });
    }
  }

  const shortfalls = slots.filter((slot) => slot.available < slot.wanted);
  const supplied = slots.reduce(
    (total, slot) => total + Math.min(slot.wanted, slot.available),
    0,
  );
  const wanted = slots.reduce((total, slot) => total + slot.wanted, 0);

  return { slots, supplied, wanted, shortfalls, feasible: shortfalls.length === 0 };
}

/**
 * Plain sentences a teacher can act on, one per shortfall.
 *
 * Deliberately not "insufficient questions" — every line names the gap and the
 * two ways out of it.
 */
export function describeShortfalls(feasibility: Feasibility): string[] {
  return feasibility.shortfalls.map((slot) => {
    const short = slot.wanted - slot.available;
    const typeName = TYPE_NAMES[slot.type] ?? slot.type;
    const difficulty = slot.difficulty.toLowerCase();

    if (slot.available === 0) {
      return `You asked for ${slot.wanted} ${difficulty} ${typeName} ${plural(slot.wanted, "question")}, and the bank has none in this scope. Write ${slot.wanted}, or change the mix.`;
    }
    return `You asked for ${slot.wanted} ${difficulty} ${typeName} ${plural(slot.wanted, "question")} and the bank has ${slot.available}. Write ${short} more, or change the mix.`;
  });
}

const TYPE_NAMES: Partial<Record<QuestionType, string>> = {
  MCQ: "multiple-choice",
  MULTI_SELECT: "multi-select",
  TRUE_FALSE: "true/false",
  NUMERIC: "numeric",
  FILL_BLANK: "fill-the-blank",
  ASSERTION_REASON: "assertion–reason",
  VSA: "very short answer",
  SA: "short answer",
  LA: "long answer",
  CASE_STUDY: "case study",
};

function plural(count: number, word: string) {
  return count === 1 ? word : `${word}s`;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
