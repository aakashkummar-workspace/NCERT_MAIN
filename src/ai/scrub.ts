/**
 * PII scrubbing.
 *
 * Pure, and tested on its own, because this is the function that decides
 * whether a provider incident is also a student-data incident.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 * **No student name, phone number, email or school name is ever sent to a
 * model.** Prompts carry opaque identifiers — `S_7f3a`, not "Arun Kumar" — and
 * the mapping stays in our database, re-applied when the answer is rendered.
 *
 * ---------------------------------------------------------------------------
 * Why an allow-list, not a deny-list
 * ---------------------------------------------------------------------------
 * A deny-list scrubs the fields somebody remembered. The first time a feature
 * adds `guardianName` to its payload, a deny-list ships it to the provider and
 * nothing anywhere says so.
 *
 * So `scrub` keeps only what a caller explicitly declares safe, and drops
 * everything else. A field added later is missing from the prompt — which is a
 * visible bug in the output — rather than present in it, which is not visible
 * at all until it is a headline.
 */

/**
 * A stable, opaque handle for one entity.
 *
 * Deterministic within a process so the same student is the same token across
 * every call in one generation — a model reasoning about "S_7f3a and S_91c2"
 * needs them to stay distinct and stay put. Derived from the id, so it carries
 * nothing about the person.
 */
export function opaqueId(prefix: string, id: string): string {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, "0").slice(0, 6)}`;
}

/** Values a prompt may legitimately carry: no free text about a person. */
export type SafeValue = string | number | boolean | null | SafeValue[] | { [key: string]: SafeValue };

/**
 * Fields that never leave, whatever a caller declares.
 *
 * The allow-list already excludes these — this is the second lock, so that a
 * caller who declares `["fullName"]` because it seemed harmless is refused
 * rather than obeyed.
 */
const NEVER = new Set([
  "fullname",
  "name",
  "firstname",
  "lastname",
  "phone",
  "mobile",
  "email",
  "address",
  "guardianname",
  "guardianphone",
  "organizationname",
  "schoolname",
  "rollnumber",
  "joincode",
  "password",
  "passwordhash",
  "token",
  "ip",
  "useragent",
]);

export class UnsafeField extends Error {
  constructor(field: string) {
    super(
      `"${field}" identifies a person and may never be sent to a model. ` +
        `Send an opaque id instead — see src/ai/scrub.ts.`,
    );
    this.name = "UnsafeField";
  }
}

/**
 * Keeps `allowed` and drops the rest, recursively.
 *
 * Throws on a field in the never-list rather than silently dropping it: a
 * caller asking to send a phone number has misunderstood something, and a quiet
 * drop leaves them thinking it worked.
 */
export function scrub<T extends Record<string, unknown>>(
  input: T,
  allowed: readonly string[],
): Record<string, SafeValue> {
  for (const field of allowed) {
    if (NEVER.has(field.toLowerCase())) throw new UnsafeField(field);
  }

  const keep = new Set(allowed);
  const out: Record<string, SafeValue> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!keep.has(key)) continue;
    out[key] = sanitise(value);
  }

  return out;
}

function sanitise(value: unknown): SafeValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitise);
  if (typeof value === "object") {
    const out: Record<string, SafeValue> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // The never-list applies at every depth. A nested `student: { fullName }`
      // is the shape this would otherwise miss.
      if (NEVER.has(key.toLowerCase())) continue;
      out[key] = sanitise(inner);
    }
    return out;
  }
  return null;
}

/**
 * A last look at the assembled prompt, before it leaves.
 *
 * Belt and braces over `scrub`, and deliberately so: prompt text is assembled
 * from template strings, and a template is exactly the place a name gets
 * interpolated without going through a scrubbed payload at all.
 *
 * Conservative on purpose. It looks for shapes that are unambiguous — an email,
 * a ten-digit Indian mobile — rather than trying to recognise names, which
 * cannot be done reliably and would reject "Pythagoras" on a maths paper.
 */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:^|[^\d])([6-9]\d{9})(?:[^\d]|$)/;

export type LeakCheck = { ok: true } | { ok: false; kind: "email" | "phone" };

export function checkForLeaks(text: string): LeakCheck {
  if (EMAIL.test(text)) return { ok: false, kind: "email" };
  if (PHONE.test(text)) return { ok: false, kind: "phone" };
  return { ok: true };
}
