/**
 * Mark schemes for the answers a person marks.
 *
 * Pure, because this decides what a teacher is allowed to save and what a
 * student is later shown as the reason for their mark. Both need to be
 * arguable, and a function that reads a database cannot be argued with months
 * afterwards.
 *
 * ---------------------------------------------------------------------------
 * Why a rubric at all
 * ---------------------------------------------------------------------------
 * The marking board already orders answers by question and hides names, so
 * twenty-four answers are marked in one sitting against one standard. But that
 * standard lives in the marker's head, and a head drifts — by answer twenty it
 * is not the standard answer three was marked against, and neither the teacher
 * nor the student ever finds out.
 *
 * A rubric is that standard written down. It also turns the mark into something
 * a student can learn from: "method 2 of 3, working 1 of 2, answer 0 of 1" says
 * where it went; "3 out of 6" says only that it did.
 *
 * ---------------------------------------------------------------------------
 * The invariant
 * ---------------------------------------------------------------------------
 * **The criteria must sum to the question's marks.** A rubric adding to 5 on a
 * six-mark question cannot award full marks to a perfect answer, and nobody
 * discovers that until the twentieth paper — by which point every mark given is
 * wrong and re-marking is the only fix.
 */

export type Criterion = {
  id: string;
  /** What is being judged: "Method", "Working shown", "Final answer". */
  label: string;
  /** The most this criterion can award. */
  marks: number;
  /** What earns them. Optional, and the difference between a rubric and a list. */
  descriptor?: string | null;
};

export type Rubric = { criteria: Criterion[] };

export type RubricProblem = {
  field: "criteria" | "marks" | "label" | "total";
  message: string;
  /** Which criterion, when it is about one. */
  index?: number;
};

/** More than this and a teacher is filling in a form, not marking. */
export const MAX_CRITERIA = 8;

/**
 * Everything that must be true before a rubric can be saved.
 *
 * Errors only — there is no warning tier here. Every rule below produces a mark
 * scheme that cannot be used correctly, and letting one through to be
 * discovered mid-marking is worse than refusing it while it is being typed.
 */
export function validateRubric(
  rubric: Rubric | null,
  questionMarks: number,
): RubricProblem[] {
  // No rubric is a valid state. A mark scheme is an improvement on typing a
  // number, not a gate in front of it.
  if (rubric === null) return [];

  const problems: RubricProblem[] = [];
  const { criteria } = rubric;

  if (!Array.isArray(criteria) || criteria.length === 0) {
    return [
      {
        field: "criteria",
        message: "A mark scheme needs at least one thing to mark against.",
      },
    ];
  }

  if (criteria.length > MAX_CRITERIA) {
    problems.push({
      field: "criteria",
      message: `${MAX_CRITERIA} criteria is as many as a marker can hold at once. Combine some.`,
    });
  }

  const seen = new Set<string>();
  for (const [index, criterion] of criteria.entries()) {
    const label = (criterion.label ?? "").trim();

    if (label.length < 2) {
      problems.push({
        field: "label",
        index,
        message: "Every criterion needs a name the marker will recognise.",
      });
    }

    // Two criteria called the same thing produce two boxes a marker cannot
    // tell apart, and a breakdown a student cannot read.
    const key = label.toLowerCase();
    if (key.length >= 2 && seen.has(key)) {
      problems.push({
        field: "label",
        index,
        message: `Two criteria are both called "${label}".`,
      });
    }
    seen.add(key);

    if (!Number.isFinite(criterion.marks) || criterion.marks <= 0) {
      problems.push({
        field: "marks",
        index,
        message: "A criterion worth nothing is a note, not a criterion.",
      });
    }

    // Half marks are real in CBSE marking; thirds are not, and a rubric that
    // permits them produces totals that do not add up on paper.
    if (Number.isFinite(criterion.marks) && (criterion.marks * 2) % 1 !== 0) {
      problems.push({
        field: "marks",
        index,
        message: "Marks go in halves. 1.5 is fine; 1.33 is not.",
      });
    }
  }

  const total = criteria.reduce(
    (sum, criterion) => sum + (Number.isFinite(criterion.marks) ? criterion.marks : 0),
    0,
  );
  if (Math.abs(total - questionMarks) > 1e-9) {
    // The invariant. Discovered at the twentieth paper, this costs every mark
    // already given.
    problems.push({
      field: "total",
      message:
        total < questionMarks
          ? `The criteria add up to ${total} but the question is worth ${questionMarks}. A perfect answer could not get full marks.`
          : `The criteria add up to ${total} but the question is worth ${questionMarks}. A perfect answer would score more than the question is worth.`,
    });
  }

  return problems;
}

export type CriterionScore = {
  criterionId: string;
  marks: number;
  /** Optional, per criterion. Where the useful feedback actually lives. */
  note?: string | null;
};

export type ScoreProblem = { criterionId?: string; message: string };

/**
 * Everything that must be true before a marked rubric can be stored.
 *
 * Separate from `validateRubric` on purpose: one guards the mark scheme a
 * teacher writes, the other guards the marks they award against it, and the two
 * are used at different moments by different people.
 */
export function validateScores(
  rubric: Rubric,
  scores: CriterionScore[],
): ScoreProblem[] {
  const problems: ScoreProblem[] = [];
  const byId = new Map(rubric.criteria.map((criterion) => [criterion.id, criterion]));

  // Every criterion answered. A partly filled rubric produces a total that
  // looks like a judgement and is actually an omission.
  for (const criterion of rubric.criteria) {
    if (!scores.some((score) => score.criterionId === criterion.id)) {
      problems.push({
        criterionId: criterion.id,
        message: `${criterion.label} has not been marked.`,
      });
    }
  }

  const counted = new Set<string>();
  for (const score of scores) {
    const criterion = byId.get(score.criterionId);
    if (!criterion) {
      problems.push({
        criterionId: score.criterionId,
        message: "That criterion is not on this question's mark scheme.",
      });
      continue;
    }

    if (counted.has(score.criterionId)) {
      problems.push({
        criterionId: score.criterionId,
        message: `${criterion.label} has been marked twice.`,
      });
    }
    counted.add(score.criterionId);

    if (!Number.isFinite(score.marks) || score.marks < 0) {
      problems.push({
        criterionId: score.criterionId,
        message: `${criterion.label} cannot be a negative mark.`,
      });
      continue;
    }

    // Refused, never clamped — the same rule the total-mark box follows. A
    // marker typing 3 into a 2-mark criterion has made a mistake, and silently
    // storing 2 hides it from them now and from the student's total forever.
    if (score.marks > criterion.marks) {
      problems.push({
        criterionId: score.criterionId,
        message: `${criterion.label} is worth ${criterion.marks}, so ${score.marks} is not a mark it can give.`,
      });
    }

    if ((score.marks * 2) % 1 !== 0) {
      problems.push({
        criterionId: score.criterionId,
        message: `${criterion.label}: marks go in halves.`,
      });
    }
  }

  return problems;
}

/** What the criteria add up to. The only place a rubric total is computed. */
export function totalFor(scores: CriterionScore[]): number {
  return scores.reduce(
    (sum, score) => sum + (Number.isFinite(score.marks) ? score.marks : 0),
    0,
  );
}

/**
 * Read a stored rubric back, or null.
 *
 * Stored as JSON, so it arrives as `unknown` and every field has to be checked.
 * A rubric that came back malformed is treated as absent rather than as an
 * empty one: absent means "type a total", and empty would mean "this question
 * is worth nothing".
 */
export function parseRubric(value: unknown): Rubric | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { criteria?: unknown };
  if (!Array.isArray(candidate.criteria) || candidate.criteria.length === 0) {
    return null;
  }

  const criteria: Criterion[] = [];
  for (const raw of candidate.criteria) {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.label !== "string") return null;
    if (typeof row.marks !== "number" || !Number.isFinite(row.marks)) return null;
    criteria.push({
      id: row.id,
      label: row.label,
      marks: row.marks,
      descriptor: typeof row.descriptor === "string" ? row.descriptor : null,
    });
  }
  return { criteria };
}
