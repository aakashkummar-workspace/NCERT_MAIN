/**
 * The gate between a model's draft and a teacher's screen.
 *
 * Pure and deterministic, like the tutor's guard: the prompt says "never more
 * than a row is worth", and this is what makes it true. A draft that breaks a
 * rule is REFUSED, never repaired — a mark clamped from 4 to 3 is a number the
 * model did not give and the teacher did not choose, and it would look exactly
 * like a considered judgement.
 *
 * The total is derived from the rows whenever there is a scheme. The model's
 * own sum is not read, for the reason `awardByRubric` has no total parameter:
 * two numbers that must agree will eventually not.
 */

export type DraftInput = {
  readable: boolean;
  criteria: { index: number; marks: number; reason: string }[];
  total: number;
};

export type SchemeRow = { id: string; marks: number };

/**
 * How sure a draft may claim to be. Without a written scheme every draft is a
 * judgement about how many marks an answer is worth, and a teacher reading
 * "high" beside it would take the number on trust. The prompt says the same;
 * this is the rule that does not depend on the model reading it.
 */
export function draftConfidence(
  claimed: "low" | "medium" | "high",
  hasScheme: boolean,
): "low" | "medium" | "high" {
  return !hasScheme && claimed === "high" ? "medium" : claimed;
}

export type CheckedDraft =
  | {
      ok: true;
      readable: boolean;
      total: number | null;
      criteria: { criterionId: string; marks: number; reason: string }[] | null;
    }
  | { ok: false; message: string };

const inHalves = (value: number) => Number.isFinite(value) && Math.round(value * 2) === value * 2;

export function checkDraft(
  draft: DraftInput,
  scheme: { maxMarks: number; rows: SchemeRow[] | null },
): CheckedDraft {
  if (!draft.readable) {
    // Nothing to check: an unreadable answer carries no marks at all, whatever
    // the model put in the number fields.
    return { ok: true, readable: false, total: null, criteria: null };
  }

  if (!scheme.rows) {
    if (!inHalves(draft.total) || draft.total < 0 || draft.total > scheme.maxMarks) {
      return {
        ok: false,
        message: `The draft gave ${draft.total} out of ${scheme.maxMarks}, which is not a mark this question can have.`,
      };
    }
    return { ok: true, readable: true, total: draft.total, criteria: null };
  }

  const rows = scheme.rows;
  const seen = new Set<number>();
  for (const entry of draft.criteria) {
    // An index that was not offered is not clamped to the nearest row: that
    // would file the mark under a criterion the model was not talking about.
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= rows.length) {
      return { ok: false, message: "The draft marked a row the scheme does not have." };
    }
    if (seen.has(entry.index)) {
      return { ok: false, message: "The draft marked one row of the scheme twice." };
    }
    seen.add(entry.index);
    const row = rows[entry.index]!;
    if (!inHalves(entry.marks) || entry.marks < 0 || entry.marks > row.marks) {
      return {
        ok: false,
        message: `The draft gave ${entry.marks} on a row worth ${row.marks}.`,
      };
    }
  }
  // Every row or none — the rule a teacher's own rubric marking follows.
  if (seen.size !== rows.length) {
    return { ok: false, message: "The draft did not mark every row of the scheme." };
  }

  const ordered = [...draft.criteria].sort((a, b) => a.index - b.index);
  return {
    ok: true,
    readable: true,
    total: ordered.reduce((sum, entry) => sum + entry.marks, 0),
    criteria: ordered.map((entry) => ({
      criterionId: rows[entry.index]!.id,
      marks: entry.marks,
      reason: entry.reason.trim(),
    })),
  };
}
