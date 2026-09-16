import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "./authorize";

/**
 * Sessions.
 *
 * The cookie carries a random 32-byte token. Only its SHA-256 is stored, so a
 * database dump is not a session-hijack kit.
 *
 * SHA-256 rather than argon2 here on purpose: the token is 256 bits of CSPRNG
 * output, so there is no dictionary to attack and nothing for a slow hash to
 * buy. It is also read on every single request, and a 19 MiB hash on the hot
 * path is a self-inflicted denial of service.
 */

export const SESSION_COOKIE = "sahayak_sid";

/**
 * Lifetimes differ by role because the risk differs. A school term should not
 * log a child out mid-revision; a platform admin's session should not outlive
 * an afternoon.
 */
export const SESSION_LIFETIME_MS: Record<Role, number> = {
  OWNER: 14 * 24 * 60 * 60 * 1000,
  ADMIN: 14 * 24 * 60 * 60 * 1000,
  TEACHER: 14 * 24 * 60 * 60 * 1000,
  STUDENT: 30 * 24 * 60 * 60 * 1000,
  PARENT: 30 * 24 * 60 * 60 * 1000,
};

/** Absolute cap, regardless of sliding renewal. */
export const SESSION_ABSOLUTE_MAX_MS = 90 * 24 * 60 * 60 * 1000;

export type SessionToken = {
  /** Goes in the cookie. Never stored. */
  raw: string;
  /** Goes in the database. Never leaves the server. */
  hash: Buffer;
};

export function createSessionToken(): SessionToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

/**
 * Constant-time comparison, for the places that compare a secret directly
 * (the cron bearer token). Session lookup goes through an indexed query on the
 * hash, which is not a timing oracle worth the name — but a bearer token
 * compared with === is.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function sessionExpiry(role: Role, now = new Date()): Date {
  return new Date(now.getTime() + SESSION_LIFETIME_MS[role]);
}

/**
 * Cookie attributes.
 *
 * `Secure` is omitted on http://localhost only — a Secure cookie is silently
 * dropped over plain http, which presents as "sign-in does nothing" and costs
 * an hour every time someone meets it.
 */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export const clearedSessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 0,
};
