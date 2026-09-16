import type { Response } from "@/core/attempts/score";

/**
 * The practice outbox: an answer written to the device before it is sent.
 *
 * ---------------------------------------------------------------------------
 * Why practice needs one at all
 * ---------------------------------------------------------------------------
 * The exam player has had this since it was built: every change goes into a
 * queue in localStorage FIRST and flushes to the server after, so a dropped
 * request, a 500 and a dead tab all mean the same thing — "not now" — and
 * nothing a student typed is lost. Practice never had it, and practice is the
 * thing actually done at home, on the wifi that reaches the router and nothing
 * else.
 *
 * ---------------------------------------------------------------------------
 * What it does NOT do, and why
 * ---------------------------------------------------------------------------
 * It does not mark the answer on the device. Practice's whole promise is
 * feedback after every question, and that feedback is the server's: the
 * explanation and the key are absent from the payload until the answer lands,
 * deliberately, because a set that arrives with the answers in it is a reading
 * exercise. Marking locally would mean shipping the key to the device, which
 * is the one thing the sealed payload exists to prevent.
 *
 * So an answer given with no connection is KEPT, not judged. The screen says
 * it is saved on the device and waiting, the verdict appears when it lands,
 * and nothing is lost in between. That is the honest meaning of
 * "offline-tolerant" for a feature whose value is a checked answer — and it is
 * why the server had to learn that a replay of the same answer is not a second
 * answer.
 *
 * Pure, so the queueing rules are unit-tested rather than clicked through.
 */

export type OutboxEntry = {
  /** The practice answer this belongs to. One entry per question, ever. */
  practiceAnswerId: string;
  response: Response;
  timeSpentSeconds: number;
  /** When the student pressed, so a long wait can be stated in the UI. */
  queuedAt: number;
  /** How many times sending has been attempted, for the screen's wording. */
  attempts: number;
};

export type Outbox = { entries: OutboxEntry[] };

export const EMPTY: Outbox = { entries: [] };

/** How many unsent answers are kept. A set is at most ten questions. */
export const MAX_ENTRIES = 10;

/**
 * Add an answer, or replace the one already queued for that question.
 *
 * Replace rather than append: a student who taps again before the first
 * attempt lands has not answered twice, and two entries for one question would
 * make the second a "different answer" the server rightly refuses.
 */
export function queue(outbox: Outbox, entry: OutboxEntry): Outbox {
  const without = outbox.entries.filter(
    (row) => row.practiceAnswerId !== entry.practiceAnswerId,
  );
  return { entries: [...without, entry].slice(-MAX_ENTRIES) };
}

/** Drop one, because the server now has it. */
export function settle(outbox: Outbox, practiceAnswerId: string): Outbox {
  return {
    entries: outbox.entries.filter(
      (row) => row.practiceAnswerId !== practiceAnswerId,
    ),
  };
}

/** Note a failed attempt, so the screen can say "still trying" honestly. */
export function attempted(outbox: Outbox, practiceAnswerId: string): Outbox {
  return {
    entries: outbox.entries.map((row) =>
      row.practiceAnswerId === practiceAnswerId
        ? { ...row, attempts: row.attempts + 1 }
        : row,
    ),
  };
}

export function pending(
  outbox: Outbox,
  practiceAnswerId: string,
): OutboxEntry | null {
  return (
    outbox.entries.find((row) => row.practiceAnswerId === practiceAnswerId) ??
    null
  );
}

/** The oldest first: answers go up in the order they were given. */
export function next(outbox: Outbox): OutboxEntry | null {
  return outbox.entries[0] ?? null;
}

/**
 * Read what a previous page load left behind.
 *
 * Tolerant of anything: a private window, cleared storage, a half-written
 * value, or a shape from an older build. Junk reads as an empty outbox,
 * because an unreadable queue must not take the runner down with it — the
 * worst case is the student answers again, which the server now handles.
 */
export function parse(raw: string | null): Outbox {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return EMPTY;
    const entries = (value as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return EMPTY;
    return {
      entries: entries.filter(isEntry).slice(-MAX_ENTRIES),
    };
  } catch {
    return EMPTY;
  }
}

export function serialise(outbox: Outbox): string {
  return JSON.stringify(outbox);
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.practiceAnswerId === "string" &&
    row.practiceAnswerId.length > 0 &&
    typeof row.timeSpentSeconds === "number" &&
    typeof row.queuedAt === "number" &&
    typeof row.attempts === "number" &&
    // `response` may legitimately be any of the four shapes, or null for a
    // question left blank — but not undefined, which is a truncated write.
    "response" in row
  );
}

/** The key. Per SESSION, so two sets open in two tabs cannot overwrite each other. */
export function outboxKey(sessionId: string): string {
  return `sahayak.practice.outbox.${sessionId}`;
}
