/**
 * The rules a concept has to satisfy.
 *
 * Pure, and separate from the writes for the usual reason — but there is a
 * sharper one here. A concept is on the SHARED curriculum plane: it has no
 * `organization_id`, every tenant reads it, and every mastery estimate,
 * learning gap, practice recommendation, study plan and term report in the
 * product is keyed on it. A bad concept is not one customer's problem; it is
 * every customer's problem at once, and it is discovered months later as
 * analytics that quietly do not add up.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists at all
 * ---------------------------------------------------------------------------
 * Until now concepts could only be SEEDED. `admin.ts` can author chapters,
 * topics and outcomes, and there was no sanctioned way to create a concept or
 * link one to an outcome — so the platform console could describe a syllabus in
 * full and still not make any of it measurable.
 *
 * That is the binding constraint on the whole product, not a missing screen:
 * the seeded curriculum holds two concepts covering five of the outcomes, so
 * mastery exists for almost nothing, and a term report — which needs three
 * measured concepts — cannot be written for any real school.
 */

/** Below this a name is not a concept, it is a typo. */
export const MIN_NAME = 3;
export const MAX_NAME = 80;

export type Problem = { field: string; message: string; severity: "error" | "warning" };

/**
 * A URL-safe, stable identifier derived from the name.
 *
 * Derived rather than typed: a slug somebody enters by hand is a slug that
 * disagrees with the name it belongs to within a month. Non-ASCII is
 * transliterated where it can be and dropped where it cannot — a slug is an
 * identifier, not a label, and the name carries the real text.
 */
export function conceptSlug(name: string): string {
  return name
    .normalize("NFKD")
    // Strip combining marks, so an accented letter becomes its base letter
    // rather than being dropped entirely. Written as an escape rather than as
    // literal combining characters: those are invisible in an editor and in a
    // diff, which is the same class of bug `npm run check:encoding` exists for.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * A slug nothing else is using.
 *
 * Collisions are resolved by suffix rather than by refusing: two subjects
 * legitimately teach "Ratio", and telling an author to invent a different NAME
 * because of an identifier they never see would be the tail wagging the dog.
 */
export function uniqueConceptSlug(name: string, taken: Iterable<string>): string {
  const base = conceptSlug(name) || "concept";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  // A thousand concepts with one name is not a collision, it is a bug upstream.
  return `${base}-${Date.now()}`;
}

export function checkConceptName(name: string): Problem[] {
  const problems: Problem[] = [];
  const trimmed = name.trim();

  if (trimmed.length < MIN_NAME) {
    problems.push({
      field: "name",
      message: `A concept name needs at least ${MIN_NAME} characters.`,
      severity: "error",
    });
  }
  if (trimmed.length > MAX_NAME) {
    problems.push({
      field: "name",
      message: `Keep it under ${MAX_NAME} characters — this is a label on a heatmap column.`,
      severity: "error",
    });
  }
  if (conceptSlug(trimmed).length === 0 && trimmed.length >= MIN_NAME) {
    problems.push({
      field: "name",
      message: "This name has no letters or digits to build an identifier from.",
      severity: "error",
    });
  }
  // A warning, never a block. The rule fires on a real pattern and would also
  // fire on a legitimate name somebody has thought about, and a rule that
  // fires on good input gets ignored on bad input.
  if (/^(chapter|unit|topic|lesson)\b/i.test(trimmed)) {
    problems.push({
      field: "name",
      message:
        "This reads like a chapter, not an idea. A concept is what a student can or cannot DO — it is what a mastery figure will be attached to.",
      severity: "warning",
    });
  }
  return problems;
}

/**
 * How much of a question's evidence belongs to this concept.
 *
 * 1.0 for the idea a question was written to test, less for one it touches in
 * passing. Zero is refused rather than stored: a link worth nothing is a link
 * that should not exist, and storing it makes the coverage figure claim an
 * outcome is covered when nothing will ever be measured through it.
 */
export function checkWeight(weight: number): Problem[] {
  if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
    return [
      {
        field: "weight",
        message: "A weight is greater than 0 and at most 1.",
        severity: "error",
      },
    ];
  }
  return [];
}

export type PrerequisiteEdge = { conceptId: string; prerequisiteId: string };

/**
 * Would adding this prerequisite close a loop?
 *
 * This is the check that has to be right. `prerequisitesOf` is walked by gap
 * detection to name a root cause — "they are stuck on similarity because they
 * are weak on ratio" — and a cycle makes that question unanswerable: every
 * concept is ultimately the cause of itself. Depending on how it is walked, the
 * result is either an infinite loop or advice that sends a teacher round in
 * circles, and the second is worse because it looks like an answer.
 *
 * A concept may not require itself either, which is the one-step case of the
 * same thing.
 */
export function wouldCycle(
  edges: PrerequisiteEdge[],
  conceptId: string,
  prerequisiteId: string,
): boolean {
  if (conceptId === prerequisiteId) return true;

  // Does `conceptId` already sit somewhere upstream of `prerequisiteId`? If it
  // does, the new edge closes the loop.
  const byConcept = new Map<string, string[]>();
  for (const edge of edges) {
    const list = byConcept.get(edge.conceptId) ?? [];
    list.push(edge.prerequisiteId);
    byConcept.set(edge.conceptId, list);
  }

  const seen = new Set<string>();
  const stack = [prerequisiteId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === conceptId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of byConcept.get(current) ?? []) stack.push(next);
  }
  return false;
}

/**
 * How deep the prerequisite chain runs from here.
 *
 * Not a rule, a warning: a chain fifteen deep is a syllabus modelled as a
 * ladder, and root-cause analysis that walks it will always land on arithmetic
 * from Class 6 — technically true and useless to a teacher deciding what to
 * reteach on Thursday.
 */
export const DEEP_CHAIN = 5;

export function chainDepth(
  edges: PrerequisiteEdge[],
  conceptId: string,
): number {
  const byConcept = new Map<string, string[]>();
  for (const edge of edges) {
    const list = byConcept.get(edge.conceptId) ?? [];
    list.push(edge.prerequisiteId);
    byConcept.set(edge.conceptId, list);
  }

  const seen = new Set<string>();
  function walk(id: string): number {
    if (seen.has(id)) return 0;
    seen.add(id);
    let deepest = 0;
    for (const next of byConcept.get(id) ?? []) {
      deepest = Math.max(deepest, 1 + walk(next));
    }
    seen.delete(id);
    return deepest;
  }
  return walk(conceptId);
}
