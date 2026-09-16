import { describe, expect, it } from "vitest";
import {
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_LIFETIME_MS,
  createSessionToken,
  hashToken,
  secretsMatch,
  sessionExpiry,
} from "@/core/identity/session";

describe("session tokens", () => {
  it("mints a 256-bit token", () => {
    const { raw } = createSessionToken();
    // base64url of 32 bytes is 43 characters.
    expect(raw).toHaveLength(43);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats a token", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(createSessionToken().raw);
    expect(seen.size).toBe(500);
  });

  it("hashes deterministically, and the hash is not the token", () => {
    const { raw, hash } = createSessionToken();
    expect(hashToken(raw).equals(hash)).toBe(true);
    expect(hash.toString("base64url")).not.toBe(raw);
    expect(hash).toHaveLength(32);
  });

  it("gives different tokens different hashes", () => {
    const a = createSessionToken();
    const b = createSessionToken();
    expect(a.hash.equals(b.hash)).toBe(false);
  });
});

describe("secretsMatch", () => {
  it("matches identical secrets", () => {
    expect(secretsMatch("abcdef", "abcdef")).toBe(true);
  });

  it("rejects different secrets of equal length", () => {
    expect(secretsMatch("abcdef", "abcdeg")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    // timingSafeEqual throws on a length mismatch, so the guard matters.
    expect(() => secretsMatch("short", "muchlongervalue")).not.toThrow();
    expect(secretsMatch("short", "muchlongervalue")).toBe(false);
  });

  it("rejects an empty secret against a real one", () => {
    expect(secretsMatch("", "real-secret")).toBe(false);
  });
});

describe("session lifetimes", () => {
  it("gives students longer than teachers — a term should not log a child out mid-revision", () => {
    expect(SESSION_LIFETIME_MS.STUDENT).toBeGreaterThan(
      SESSION_LIFETIME_MS.TEACHER,
    );
  });

  it("keeps every lifetime under the absolute cap", () => {
    for (const [role, ms] of Object.entries(SESSION_LIFETIME_MS)) {
      expect(ms, `${role} lifetime exceeds the absolute cap`).toBeLessThanOrEqual(
        SESSION_ABSOLUTE_MAX_MS,
      );
    }
  });

  it("computes an expiry in the future from a fixed now", () => {
    const now = new Date("2026-09-07T10:00:00Z");
    const expiry = sessionExpiry("TEACHER", now);
    expect(expiry.getTime()).toBe(now.getTime() + SESSION_LIFETIME_MS.TEACHER);
  });
});
