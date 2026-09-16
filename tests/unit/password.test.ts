import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  checkPassword,
  hashPassword,
  verifyPassword,
} from "@/core/identity/password";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const digest = await hashPassword("a-perfectly-fine-password");
    expect(await verifyPassword(digest, "a-perfectly-fine-password")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const digest = await hashPassword("a-perfectly-fine-password");
    expect(await verifyPassword(digest, "a-perfectly-fine-passwore")).toBe(false);
  });

  it("salts — the same password hashes differently each time", async () => {
    const a = await hashPassword("same-password-twice");
    const b = await hashPassword("same-password-twice");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "same-password-twice")).toBe(true);
    expect(await verifyPassword(b, "same-password-twice")).toBe(true);
  });

  it("uses argon2id", async () => {
    expect(await hashPassword("check-the-algorithm")).toMatch(/^\$argon2id\$/);
  });

  it("returns false rather than throwing on a malformed digest", async () => {
    // A thrown error here could be caught upstream and mistaken for "not a
    // password problem", which would let a sign-in through.
    expect(await verifyPassword("not-a-digest", "anything")).toBe(false);
    expect(await verifyPassword("", "anything")).toBe(false);
  });
});

describe("password rules", () => {
  it("requires the minimum length", () => {
    const result = checkPassword("x".repeat(MIN_PASSWORD_LENGTH - 1));
    expect(result.ok).toBe(false);
  });

  it("accepts exactly the minimum length", () => {
    expect(checkPassword("x".repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it("accepts a long passphrase with no punctuation", () => {
    // Composition rules produce Summer2026! and nothing else.
    expect(checkPassword("correct horse battery staple").ok).toBe(true);
  });

  it("rejects an absurdly long input", () => {
    expect(checkPassword("x".repeat(500)).ok).toBe(false);
  });
});
