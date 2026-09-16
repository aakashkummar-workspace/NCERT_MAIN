import type { Response } from "./score";

/**
 * Is this the same answer the server already has?
 *
 * ---------------------------------------------------------------------------
 * Why it exists
 * ---------------------------------------------------------------------------
 * A device that sent an answer and never heard back has to be able to ask
 * again — school wifi reaches the router and nothing else, and that is the
 * condition homework is actually done in. So a REPLAY of the same answer must
 * be safe, while a DIFFERENT answer to a question already answered stays
 * refused: practice a student could walk until every verdict was green would
 * make its evidence worthless.
 *
 * Separating those two needs one honest comparison, and it has to be about
 * MEANING rather than about bytes:
 *
 *  - the same options ticked in a different order are the same answer, because
 *    the marker already treats them that way (`markAnswer` sorts keys);
 *  - text is trimmed, because a trailing space a phone keyboard added is not a
 *    different answer — and it is NOT case-folded, because a text key may be
 *    case-sensitive and this function must not decide that;
 *  - a number is compared as a number, so `7` and `7.0` match, which is the
 *    same rule the response builder already applies.
 *
 * Pure and shared: the exam player, practice and the mistake retry all send
 * responses through `buildResponse`, and a second opinion about what "the same
 * answer" means is how one of them eventually disagrees with the marker.
 */
export function sameResponse(a: Response | null, b: Response | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case "choice": {
      const other = b as Extract<Response, { kind: "choice" }>;
      if (a.keys.length !== other.keys.length) return false;
      const left = [...a.keys].sort();
      const right = [...other.keys].sort();
      return left.every((key, index) => key === right[index]);
    }
    case "boolean":
      return a.value === (b as Extract<Response, { kind: "boolean" }>).value;
    case "numeric":
      return a.value === (b as Extract<Response, { kind: "numeric" }>).value;
    case "text":
      return (
        a.value.trim() === (b as Extract<Response, { kind: "text" }>).value.trim()
      );
    default:
      // A kind added later is not silently "the same". An unknown shape must
      // read as a different answer, which refuses rather than replays.
      return false;
  }
}
