/**
 * Is a learning-outcome statement usable as prompt material?
 *
 * With no seeded question bank to few-shot from (RISKS.md, Risk 1), an outcome
 * statement is the ONLY grounding a generator has. "Triangles" is a label; it
 * cannot produce a question. "Applies the AA criterion to decide whether two
 * triangles are similar" can.
 *
 * Pure and free of `server-only`, because the same check has to run in two
 * places: live under the author's cursor, and again on the server, which is
 * authoritative. One implementation, so the warning shown while typing is the
 * verdict recorded on save.
 *
 * It warns; it never blocks. An author may know better than a heuristic.
 */

/**
 * Verbs a student can be observed doing. Deliberately not the full Bloom list:
 * these are the ones that survive being turned into a question.
 */
const PERFORMABLE_VERB =
  /\b(states?|defines?|describes?|explains?|identifies?|classifies?|compares?|applies|apply|uses?|calculates?|solves?|derives?|proves?|deduces?|constructs?|draws?|measures?|predicts?|justifies?|analyses?|evaluates?|interprets?|distinguishes?|converts?|estimates?|lists?|recalls?|writes?|balances?|names?|relates?|arranges?|selects?)\b/i;

export type OutcomeQuality = { ok: true } | { ok: false; reason: string };

export function checkOutcomeStatement(statement: string): OutcomeQuality {
  const trimmed = statement.trim();

  if (trimmed.length < 25) {
    return {
      ok: false,
      reason:
        "Too short to write a question from. Say what a student can DO, not what the topic is called.",
    };
  }

  if (trimmed.split(/\s+/).length < 6) {
    return { ok: false, reason: "This reads as a label rather than a sentence." };
  }

  if (trimmed.length > 400) {
    return {
      ok: false,
      reason: "Longer than one claim. Split it into two outcomes.",
    };
  }

  // The verb has to be at the FRONT.
  //
  // Matching anywhere in the sentence passes "The chapter is about the
  // properties of similar triangles and their many uses", where "uses" is a
  // noun. Requiring it in the opening words fixes that and teaches the shape
  // every good outcome has: a verb the student performs, then the thing they
  // perform it on.
  const opening = trimmed.split(/\s+/).slice(0, 4).join(" ");
  if (!PERFORMABLE_VERB.test(opening)) {
    return {
      ok: false,
      reason:
        "Start with a verb the student performs — states, applies, derives, compares — so a question can be written from this sentence alone.",
    };
  }

  return { ok: true };
}
