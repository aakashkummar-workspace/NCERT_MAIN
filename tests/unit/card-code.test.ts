import { describe, expect, it } from "vitest";
import {
  CARD_ALPHABET,
  CARD_CODE_LENGTH,
  formatCardCode,
  generateCardCode,
  hashCardCode,
  normaliseCardCode,
} from "@/core/identity/card-code";

describe("sign-in card codes", () => {
  it("draws only from the unambiguous alphabet", () => {
    for (let run = 0; run < 200; run++) {
      const code = generateCardCode();
      expect(code).toHaveLength(CARD_CODE_LENGTH);
      for (const character of code) expect(CARD_ALPHABET).toContain(character);
    }
  });

  it("leaves out every character a child will misread", () => {
    for (const confusable of ["0", "O", "1", "I", "L"]) {
      expect(CARD_ALPHABET).not.toContain(confusable);
    }
  });

  it("is long enough to stand without a PIN", () => {
    // The card is the whole credential. Under 2^56 would be guessable by a
    // patient script; this pins the arithmetic so shortening it fails here.
    expect(CARD_CODE_LENGTH * Math.log2(CARD_ALPHABET.length)).toBeGreaterThan(56);
  });

  it("forgives case, spaces and the printed dashes", () => {
    const code = "K7QM3XPD9W2B";
    expect(normaliseCardCode("k7qm-3xpd-9w2b")).toBe(code);
    expect(normaliseCardCode(" K7QM 3XPD 9W2B ")).toBe(code);
    expect(normaliseCardCode(formatCardCode(code))).toBe(code);
  });

  it("refuses rather than guesses at a character that is not on any card", () => {
    expect(normaliseCardCode("K7QM-3XPD-9W2O")).toBeNull();
    expect(normaliseCardCode("K7QM-3XPD-9W21")).toBeNull();
    expect(normaliseCardCode("K7QM-3XPD")).toBeNull();
    expect(normaliseCardCode("")).toBeNull();
  });

  it("prints in three groups of four", () => {
    expect(formatCardCode("K7QM3XPD9W2B")).toBe("K7QM-3XPD-9W2B");
  });

  it("hashes into its own namespace", () => {
    const hash = hashCardCode("K7QM3XPD9W2B");
    expect(hash).toHaveLength(32);
    expect(hash.equals(hashCardCode("K7QM3XPD9W2B"))).toBe(true);
    expect(hash.equals(hashCardCode("K7QM3XPD9W2C"))).toBe(false);
  });
});
