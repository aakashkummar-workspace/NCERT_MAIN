/**
 * Turning what a student did on screen into a `Response`, in one place.
 *
 * Pure, and imported by the exam player, the practice runner and the mistake
 * retry alike. Three components used to build their own responses, and they
 * drifted in exactly the way that costs a student marks without anybody
 * noticing: two of them sent a typed number as `{kind: "text"}`, which the
 * numeric marker does not read, so a correct answer was marked wrong; and both
 * sent a multi-select as one key, so a question with two right options could
 * never be got right. One helper means "what counts as an answer" is decided
 * once, next to the marker that reads it.
 *
 * ---------------------------------------------------------------------------
 * Blank is null, everywhere
 * ---------------------------------------------------------------------------
 * An empty selection, a box holding only spaces, and a number field holding
 * something that is not a number are all the same fact: the student did not
 * answer. They are normalised to `null` before they are stored, because every
 * reader downstream — the pending-marks count, the result page, the mistake
 * recorder — asks `response !== null`, and a `{keys: []}` that reached them
 * was counted as an answer awaiting marking. A blank objective question is
 * settled, not pending.
 */

import type { Response } from "./score";

/** Question types whose options may be ticked more than one at a time. */
const MULTI = new Set(["MULTI_SELECT"]);

/**
 * The keys after tapping one option.
 *
 * On a single-answer question the tap MOVES the choice; on a multi-select it
 * toggles that option and leaves the others alone.
 */
export function toggleKey(type: string, keys: string[], key: string): string[] {
  if (!MULTI.has(type)) return [key];
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

export function isMultiSelect(type: string): boolean {
  return MULTI.has(type);
}

/**
 * A number, read from exactly what the student typed.
 *
 * The raw text is what the input keeps; this runs only when a response is
 * built. Re-normalising the text through `Number()` on every keystroke is what
 * made "0.05" impossible to type: "0.0" became "0" before the 5 arrived.
 * A comma is read as a decimal point, because a phone keyboard in some locales
 * offers only that.
 */
export function parseNumber(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (text === "") return null;
  if (!/^[-+]?(?:[0-9]+[.]?[0-9]*|[.][0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * What a student has in front of them on one question, before it is sent.
 *
 * `options` is whether the question renders choices; `text` holds both a
 * typed answer and a typed number, raw.
 */
export type Draft = {
  type: string;
  hasOptions: boolean;
  keys: string[];
  bool: boolean | null;
  text: string;
};

/** The response a draft stands for, or null when it is not an answer yet. */
export function buildResponse(draft: Draft): Response {
  if (draft.hasOptions) {
    return draft.keys.length > 0 ? { kind: "choice", keys: draft.keys } : null;
  }
  if (draft.type === "TRUE_FALSE") {
    return draft.bool === null ? null : { kind: "boolean", value: draft.bool };
  }
  if (draft.type === "NUMERIC") {
    const value = parseNumber(draft.text);
    return value === null ? null : { kind: "numeric", value };
  }
  return draft.text.trim().length > 0 ? { kind: "text", value: draft.text } : null;
}

/**
 * Whether a stored or sent response is an answer at all.
 *
 * Reads `unknown` because stored responses come out of a JSON column and rows
 * written before blanks were normalised still hold `{keys: []}`.
 */
export function isBlankResponse(response: unknown): boolean {
  if (response === null || response === undefined) return true;
  if (typeof response !== "object") return true;
  const value = response as Record<string, unknown>;
  switch (value.kind) {
    case "choice":
      return !Array.isArray(value.keys) || value.keys.length === 0;
    case "text":
      return typeof value.value !== "string" || value.value.trim().length === 0;
    case "numeric":
      return typeof value.value !== "number" || !Number.isFinite(value.value);
    case "boolean":
      return typeof value.value !== "boolean";
    case "paper":
      // Written on a paper script: an answer, just not one held here.
      return false;
    default:
      return true;
  }
}

/**
 * The first sequence number a freshly loaded player may use.
 *
 * One above the highest the server already holds on any question of the
 * attempt. The server keeps a save only when its sequence beats the stored
 * one, so a player that restarted at 1 after a reload had every later edit to
 * an answered question ignored — silently, under a header saying Saved.
 */
export function resumeSequence(questions: { clientSeq: number }[]): number {
  return Math.max(0, ...questions.map((question) => question.clientSeq)) + 1;
}

/** The response to store: itself, or null when it is blank. */
export function normaliseResponse(response: Response): Response {
  return isBlankResponse(response) ? null : response;
}
