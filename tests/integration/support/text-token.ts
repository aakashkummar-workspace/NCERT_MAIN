import { randomUUID } from "node:crypto";

/**
 * A unique token for question TEXT, made of letters only.
 *
 * Not `randomUUID()`. About one UUID in three hundred contains exactly ten
 * digits in a row starting with 6–9 — which is what an Indian mobile number
 * looks like, and what the AI gateway's leak check (`checkForLeaks`) refuses to
 * send. A stem carrying one was quoted in the next generation's "already in
 * the bank" list, the prompt was refused as UNSAFE_PROMPT, and a test failed
 * roughly once every few hundred runs with nothing to say why.
 */
export function textToken(): string {
  return randomUUID()
    .replace(/-/g, "")
    .replace(/\d/g, (digit) => "ghijklmnop"[Number(digit)]!);
}
