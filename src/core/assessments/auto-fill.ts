/**
 * Filling a paper from the bank by rule. Pure.
 *
 * The AI paper request (core/assessments/from-request.ts) decides only the
 * PLAN — class, chapters, shape, length. Which questions go on the paper is
 * decided here, from APPROVED bank questions only, so a paper built from a
 * sentence contains nothing a teacher has not already approved — the same
 * promise the hand-built paper makes — and nothing a model wrote.
 *
 * ---------------------------------------------------------------------------
 * The rules
 * ---------------------------------------------------------------------------
 * - **Spread across chapters.** A paper on "Triangles and Circles" that is
 *   eighteen Triangles questions and two Circles ones measures one chapter.
 *   Within each slot the picker takes one question per chapter in turn.
 * - **Deterministic for a seed.** The same plan and the same seed give the
 *   same paper, so a preview could never disagree with the outcome; a new seed
 *   (a new paper) draws a different selection from the same pool.
 * - **A short difficulty is topped up from the nearest one, and said.** A
 *   teacher who asked for fifteen questions wants fifteen: when the bank has
 *   four easy ones, three medium ones of the SAME type and chapters fill in,
 *   ties going easier (the `pickNearest` rule practice uses — serving harder
 *   than asked is the direction this must not drift in). Every substitution is
 *   reported. Nothing reaches for another type or another chapter.
 * - **What is still short is said, with its numbers.**
 * - **An outcome index or class index that was not offered is DROPPED, never
 *   clamped** — clamping would silently set a paper on a different chapter.
 */
import type { QuestionType } from "@/core/questions/validate";
import { allocate, type Difficulty } from "./blueprint";
import type { SectionPlan } from "./pattern";

export type Candidate = {
  id: string;
  type: QuestionType;
  difficulty: Difficulty;
  marks: number;
  chapterId: string | null;
};

export type Picked = Candidate & { section: string | null; choiceGroup: number | null };

export type Short = { label: string; wanted: number; found: number };

/** Questions of a neighbouring difficulty used because the asked-for one ran out. */
export type Substitution = { type: QuestionType; from: Difficulty; to: Difficulty; count: number };

/** Nearest difficulties first, ties going easier. */
const NEAREST: Record<Difficulty, Difficulty[]> = {
  EASY: ["MEDIUM", "HARD"],
  MEDIUM: ["EASY", "HARD"],
  HARD: ["MEDIUM", "EASY"],
};

/** A stable pseudo-random order for a seed: FNV-1a over seed and id. */
function rank(seed: string, id: string): number {
  let hash = 0x811c9dc5;
  for (const char of seed + ":" + id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Up to `wanted` candidates, one chapter at a time in turn. Chapters are
 * visited in a seeded order and each chapter's questions in a seeded order, so
 * the selection is spread, repeatable, and different for a different paper.
 */
function takeSpread(pool: Candidate[], wanted: number, seed: string): Candidate[] {
  const byChapter = new Map<string, Candidate[]>();
  for (const candidate of pool) {
    const key = candidate.chapterId ?? "";
    byChapter.set(key, [...(byChapter.get(key) ?? []), candidate]);
  }
  const queues = [...byChapter.entries()]
    .sort(([a], [b]) => rank(seed, a) - rank(seed, b))
    .map(([, rows]) => [...rows].sort((a, b) => rank(seed, a.id) - rank(seed, b.id)));

  const taken: Candidate[] = [];
  while (taken.length < wanted && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) taken.push(next);
      if (taken.length === wanted) break;
    }
  }
  return taken;
}

const TYPE_WORDS: Partial<Record<QuestionType, string>> = {
  MCQ: "multiple-choice",
  TRUE_FALSE: "true/false",
  NUMERIC: "numeric",
  ASSERTION_REASON: "assertion–reason",
  VSA: "very short answer",
  SA: "short answer",
  LA: "long answer",
  CASE_STUDY: "case study",
};

/**
 * A custom paper: questions per difficulty, then per type within it, by the
 * builder's own `allocate` (which never loses a question to rounding).
 */
export function pickForMix(
  candidates: Candidate[],
  plan: {
    questionCount: number;
    difficultyMix: Record<Difficulty, number>;
    typeMix: Partial<Record<QuestionType, number>>;
  },
  seed: string,
): { picked: Picked[]; short: Short[]; substitutions: Substitution[] } {
  const used = new Set<string>();
  const picked: Picked[] = [];
  const short: Short[] = [];
  const substitutions: Substitution[] = [];
  // What each slot still lacks, with what it asked for and found, so a
  // shortfall is reported in the teacher's own numbers.
  const missing: { difficulty: Difficulty; type: QuestionType; count: number; wanted: number; found: number }[] = [];
  const byDifficulty = allocate(plan.questionCount, plan.difficultyMix);
  for (const [difficulty, count] of Object.entries(byDifficulty)) {
    if (count <= 0) continue;
    const byType = allocate(count, plan.typeMix as Record<string, number>);
    for (const [type, wanted] of Object.entries(byType)) {
      if (wanted <= 0) continue;
      const pool = candidates.filter(
        (c) => c.difficulty === difficulty && c.type === type && !used.has(c.id),
      );
      const taken = takeSpread(pool, wanted, `${seed}:${difficulty}:${type}`);
      for (const row of taken) {
        used.add(row.id);
        picked.push({ ...row, section: null, choiceGroup: null });
      }
      if (taken.length < wanted) {
        missing.push({
          difficulty: difficulty as Difficulty,
          type: type as QuestionType,
          count: wanted - taken.length,
          wanted,
          found: taken.length,
        });
      }
    }
  }

  // Second pass, after every slot has had its own difficulty: top up what ran
  // out from the nearest difficulty of the same type.
  for (const gap of missing) {
    let still = gap.count;
    for (const neighbour of NEAREST[gap.difficulty]) {
      if (still === 0) break;
      const pool = candidates.filter(
        (c) => c.difficulty === neighbour && c.type === gap.type && !used.has(c.id),
      );
      const taken = takeSpread(pool, still, `${seed}:${gap.difficulty}:${gap.type}:${neighbour}`);
      for (const row of taken) {
        used.add(row.id);
        picked.push({ ...row, section: null, choiceGroup: null });
      }
      if (taken.length > 0) {
        substitutions.push({ type: gap.type, from: gap.difficulty, to: neighbour, count: taken.length });
        still -= taken.length;
      }
    }
    if (still > 0) {
      short.push({
        label: `${gap.difficulty.toLowerCase()} ${TYPE_WORDS[gap.type] ?? gap.type}`,
        wanted: gap.wanted,
        found: gap.found + (gap.count - still),
      });
    }
  }
  return { picked, short, substitutions };
}

/** The substitutions as sentences a teacher reads. */
export function describeSubstitutions(substitutions: Substitution[]): string[] {
  return substitutions.map(
    (row) =>
      `${row.count} ${row.to.toLowerCase()} ${TYPE_WORDS[row.type] ?? row.type} ${row.count === 1 ? "question" : "questions"} used in place of ${row.from.toLowerCase()} — the bank ran out.`,
  );
}

/**
 * The type mix without the types the bank holds none of in this scope, and
 * the ones dropped. Asking for 20% very short answers on a chapter with none
 * approved leaves those slots empty whatever else is done, so the mix is
 * re-shared over what exists — and the teacher is told.
 */
export function mixForBank(
  typeMix: Partial<Record<QuestionType, number>>,
  candidates: Candidate[],
): { typeMix: Partial<Record<QuestionType, number>>; dropped: QuestionType[] } {
  const held = new Set(candidates.map((c) => c.type));
  const kept = Object.entries(typeMix).filter(([type, share]) => (share ?? 0) > 0 && held.has(type as QuestionType));
  const dropped = Object.entries(typeMix)
    .filter(([type, share]) => (share ?? 0) > 0 && !held.has(type as QuestionType))
    .map(([type]) => type as QuestionType);
  if (kept.length === 0) return { typeMix, dropped: [] };
  const total = kept.reduce((sum, [, share]) => sum + (share ?? 0), 0);
  const scaled = Object.fromEntries(kept.map(([type, share]) => [type, ((share ?? 0) * 100) / total]));
  return { typeMix: allocate(100, scaled) as Partial<Record<QuestionType, number>>, dropped };
}

export function typeWord(type: QuestionType): string {
  return TYPE_WORDS[type] ?? type;
}

/**
 * A board-pattern paper: each section by its types and marks, with its "OR"
 * alternatives paired to a question of the same section and marks — the rule
 * `checkLayout` enforces at save, so a pairing made here always passes it.
 */
export function pickForSections(
  candidates: Candidate[],
  sections: SectionPlan[],
  seed: string,
): { picked: Picked[]; short: Short[]; substitutions: Substitution[] } {
  const used = new Set<string>();
  const picked: Picked[] = [];
  const short: Short[] = [];
  let group = 0;
  for (const section of sections) {
    const pool = candidates.filter(
      (c) => section.types.includes(c.type) && c.marks === section.marksEach && !used.has(c.id),
    );
    const wanted = section.count + section.internalChoices;
    const taken = takeSpread(pool, wanted, `${seed}:${section.name}`);
    for (const row of taken) used.add(row.id);

    // The first `count` are the paper; the rest become the "OR" alternatives
    // of the first few, as far as the bank allowed.
    const main = taken.slice(0, section.count);
    const alternatives = taken.slice(section.count);
    main.forEach((row, index) => {
      const alternative = alternatives[index];
      const choiceGroup = alternative ? ++group : null;
      picked.push({ ...row, section: section.name, choiceGroup });
      if (alternative) picked.push({ ...alternative, section: section.name, choiceGroup });
    });

    if (main.length < section.count) {
      short.push({
        label: `Section ${section.name} (${section.marksEach}-mark ${section.types.map((t) => TYPE_WORDS[t] ?? t).join(" or ")})`,
        wanted: section.count,
        found: main.length,
      });
    }
  }
  // Sections are by type and marks, not difficulty, so nothing is substituted.
  return { picked, short, substitutions: [] };
}

/** Percentages that sum to exactly 100, by largest remainder. All zero → the default. */
export function normaliseMix<K extends string>(raw: Record<K, number>, fallback: Record<K, number>): Record<K, number> {
  const keys = Object.keys(raw) as K[];
  const total = keys.reduce((sum, key) => sum + Math.max(0, raw[key]), 0);
  if (total <= 0) return fallback;
  // `allocate` expects shares of 100, so scale first; it then hands out the
  // rounding remainder so the result sums to exactly 100.
  const scaled = Object.fromEntries(keys.map((key) => [key, (Math.max(0, raw[key]) * 100) / total]));
  const counts = allocate(100, scaled);
  // `allocate` omits a zero share; the blueprint wants every key present.
  return Object.fromEntries(keys.map((key) => [key, counts[key] ?? 0])) as Record<K, number>;
}

/**
 * A calendar date the model wrote, as the start of that day in India, or null.
 * Anything that is not a real YYYY-MM-DD is null — a guessed date is worse
 * than asking the teacher to pick one.
 */
export function istDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00+05:30`);
  if (Number.isNaN(date.getTime())) return null;
  // Rejects 2026-02-31, which Date would roll over into March.
  const back = new Date(date.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  return back === value ? date : null;
}

/**
 * The window the teacher asked for, as instants, or null when they named
 * none or it makes no sense. "Due Friday" closes at 20:00 IST on Friday — the
 * hour the assign panel's own suggestion uses, after evening tuition and
 * before it is unfair to expect a school student to be awake. One already over, or too
 * short for the paper, is dropped rather than bent — the assign panel then
 * suggests its own and the teacher decides.
 */
export function windowFor(
  opensOn: string | null,
  closesOn: string | null,
  durationMinutes: number,
  now: Date,
): { opensAt: Date; closesAt: Date } | null {
  const closesDay = istDate(closesOn);
  if (!closesDay) return null;
  const closesAt = new Date(closesDay.getTime() + 20 * 3600_000);
  const opensDay = istDate(opensOn);
  const opensAt = opensDay && opensDay.getTime() > now.getTime() ? opensDay : now;
  if (closesAt.getTime() <= now.getTime()) return null;
  if (closesAt.getTime() - opensAt.getTime() < durationMinutes * 60_000) return null;
  return { opensAt, closesAt };
}
