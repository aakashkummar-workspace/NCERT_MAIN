import { createHash, randomInt } from "node:crypto";

/**
 * The code printed on a sign-in card. Pure, so it is unit-tested and so the
 * issuer and the sign-in route cannot disagree about what a code looks like.
 *
 * ---------------------------------------------------------------------------
 * Why twelve characters, and why this alphabet
 * ---------------------------------------------------------------------------
 * The card is the whole credential — there is no PIN beside it — so it has to
 * be unguessable on its own: 31^12 is about 2^59, which nothing online gets
 * through. And it is typed by a fourteen-year-old off a piece of card on a
 * lab keyboard, so the alphabet drops every character a child will misread:
 * no 0/O, no 1/I/L. Lower case is accepted and folded, and the dashes the card
 * prints are ignored, because a code that fails for a missing hyphen is a
 * support call nobody should have to make.
 */

export const CARD_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CARD_CODE_LENGTH = 12;

export function generateCardCode(): string {
  let code = "";
  for (let index = 0; index < CARD_CODE_LENGTH; index++) {
    // randomInt, not Math.random: this is a credential.
    code += CARD_ALPHABET[randomInt(0, CARD_ALPHABET.length)];
  }
  return code;
}

/**
 * The canonical form of whatever was typed or scanned, or null when it cannot
 * be a card code. `o` and `0` fold to nothing useful — they are not in the
 * alphabet, so a code containing one is simply wrong, and saying so beats
 * guessing which letter was meant.
 */
export function normaliseCardCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CARD_CODE_LENGTH) return null;
  for (const character of code) {
    if (!CARD_ALPHABET.includes(character)) return null;
  }
  return code;
}

/** `K7QM-3XPD-9W2B`: three groups of four, which is how people read codes. */
export function formatCardCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/**
 * Salted with a fixed prefix so a card hash can never collide with a session
 * token's hash or a login code's — three kinds of secret, three namespaces.
 */
export function hashCardCode(code: string): Buffer {
  return createHash("sha256").update(`login-card:${code}`, "utf8").digest();
}
