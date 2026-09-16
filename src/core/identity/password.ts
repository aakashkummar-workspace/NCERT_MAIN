import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing.
 *
 * argon2id with OWASP's recommended floor: 19 MiB memory, 2 iterations,
 * parallelism 1. Deliberately not tuned lower for CI speed — a fast hash in
 * tests is a fast hash in production, because nobody remembers to change it
 * back.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(
  digest: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS);
  } catch {
    // A malformed digest is a failed verification, never an exception that a
    // caller might treat as "not a password problem" and let through.
    return false;
  }
}

/**
 * Rules: length only.
 *
 * No composition requirements and no forced rotation — both produce
 * `Summer2026!` and nothing else. Length plus a breached-password check is what
 * actually moves the needle; the breach list arrives with the sign-up route in
 * a later slice, and its absence is recorded here rather than forgotten.
 */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

export type PasswordProblem =
  | { ok: true }
  | { ok: false; message: string };

export function checkPassword(plain: string): PasswordProblem {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters. Length beats punctuation.`,
    };
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `Keep it under ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  return { ok: true };
}
