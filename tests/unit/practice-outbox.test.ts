import { describe, expect, it } from "vitest";
import {
  attempted,
  EMPTY,
  MAX_ENTRIES,
  next,
  outboxKey,
  parse,
  pending,
  queue,
  serialise,
  settle,
  type OutboxEntry,
} from "@/core/practice/outbox";
import { sameResponse } from "@/core/attempts/same-response";

/**
 * The practice outbox, and the comparison that makes retrying safe.
 *
 * The property both exist for: an answer given on wifi that reaches the router
 * and nothing else is KEPT, sent again by itself, and produces one answer on
 * the server rather than a refusal.
 */

const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  practiceAnswerId: over.practiceAnswerId ?? "pa1",
  response: over.response ?? { kind: "choice", keys: ["A"] },
  timeSpentSeconds: over.timeSpentSeconds ?? 12,
  queuedAt: over.queuedAt ?? 1_700_000_000_000,
  attempts: over.attempts ?? 0,
});

describe("one entry per question, ever", () => {
  it("replaces rather than appends when the same question is answered again", () => {
    // A student who taps twice before the first attempt lands has not answered
    // twice — and two entries would make the second a DIFFERENT answer, which
    // the server rightly refuses.
    const outbox = queue(
      queue(EMPTY, entry({ response: { kind: "choice", keys: ["A"] } })),
      entry({ response: { kind: "choice", keys: ["B"] } }),
    );
    expect(outbox.entries).toHaveLength(1);
    expect(pending(outbox, "pa1")?.response).toEqual({ kind: "choice", keys: ["B"] });
  });

  it("keeps separate questions apart, oldest first", () => {
    const outbox = queue(
      queue(EMPTY, entry({ practiceAnswerId: "pa1" })),
      entry({ practiceAnswerId: "pa2" }),
    );
    expect(outbox.entries.map((row) => row.practiceAnswerId)).toEqual(["pa1", "pa2"]);
    // Answers go up in the order they were given.
    expect(next(outbox)?.practiceAnswerId).toBe("pa1");
  });

  it("never grows past a set's worth of questions", () => {
    let outbox = EMPTY;
    for (let index = 0; index < MAX_ENTRIES + 5; index++) {
      outbox = queue(outbox, entry({ practiceAnswerId: `pa${index}` }));
    }
    expect(outbox.entries).toHaveLength(MAX_ENTRIES);
    // The oldest are the ones dropped: a set is at most ten questions, so more
    // than that means something is wrong rather than something is pending.
    expect(next(outbox)?.practiceAnswerId).toBe("pa5");
  });

  it("drops one when the server has it, and leaves the rest", () => {
    const outbox = settle(
      queue(queue(EMPTY, entry({ practiceAnswerId: "pa1" })), entry({ practiceAnswerId: "pa2" })),
      "pa1",
    );
    expect(outbox.entries.map((row) => row.practiceAnswerId)).toEqual(["pa2"]);
    expect(pending(outbox, "pa1")).toBeNull();
  });

  it("counts attempts, so the screen can say 'still trying' honestly", () => {
    const outbox = attempted(queue(EMPTY, entry()), "pa1");
    expect(pending(outbox, "pa1")?.attempts).toBe(1);
  });
});

describe("what a previous page load left behind", () => {
  it("survives a round trip through storage", () => {
    const outbox = queue(EMPTY, entry());
    expect(parse(serialise(outbox))).toEqual(outbox);
  });

  it("reads junk as an empty outbox rather than throwing", () => {
    // Private window, cleared storage, a half-written value, or a shape from an
    // older build. An unreadable queue must not take the runner down with it.
    for (const raw of [
      null,
      "",
      "not json",
      "[]",
      '{"entries":"nope"}',
      '{"entries":[{"practiceAnswerId":""}]}',
      '{"entries":[{"nothing":true}]}',
    ]) {
      expect(parse(raw)).toEqual(EMPTY);
    }
  });

  it("keeps an entry whose response is null, which is a real answer state", () => {
    const blank = parse(
      JSON.stringify({
        entries: [{ practiceAnswerId: "pa1", response: null, timeSpentSeconds: 4, queuedAt: 1, attempts: 0 }],
      }),
    );
    expect(blank.entries).toHaveLength(1);
  });

  it("is keyed per session, so two tabs cannot overwrite each other", () => {
    expect(outboxKey("s1")).not.toBe(outboxKey("s2"));
    expect(outboxKey("s1")).toContain("s1");
  });
});

describe("a replay is the same answer; a change is not", () => {
  it("matches an identical choice whatever order the keys arrive in", () => {
    // The marker already sorts keys, so two tickings of the same options are
    // one answer — and a retry must not read as a new one.
    expect(
      sameResponse({ kind: "choice", keys: ["A", "B"] }, { kind: "choice", keys: ["B", "A"] }),
    ).toBe(true);
    expect(
      sameResponse({ kind: "choice", keys: ["A"] }, { kind: "choice", keys: ["A", "B"] }),
    ).toBe(false);
  });

  it("treats a trailing space as the same text and a different word as different", () => {
    expect(sameResponse({ kind: "text", value: "seven " }, { kind: "text", value: "seven" })).toBe(
      true,
    );
    // NOT case-folded: a text key may be case-sensitive, and this function has
    // no business deciding that on the marker's behalf.
    expect(sameResponse({ kind: "text", value: "Seven" }, { kind: "text", value: "seven" })).toBe(
      false,
    );
  });

  it("compares a number as a number and a boolean as a boolean", () => {
    expect(sameResponse({ kind: "numeric", value: 7 }, { kind: "numeric", value: 7.0 })).toBe(true);
    expect(sameResponse({ kind: "numeric", value: 7 }, { kind: "numeric", value: 8 })).toBe(false);
    expect(sameResponse({ kind: "boolean", value: true }, { kind: "boolean", value: true })).toBe(
      true,
    );
    expect(sameResponse({ kind: "boolean", value: true }, { kind: "boolean", value: false })).toBe(
      false,
    );
  });

  it("never calls two different kinds the same answer", () => {
    expect(sameResponse({ kind: "text", value: "7" }, { kind: "numeric", value: 7 })).toBe(false);
  });

  it("handles a blank answer without pretending it matches everything", () => {
    expect(sameResponse(null, null)).toBe(true);
    expect(sameResponse(null, { kind: "choice", keys: ["A"] })).toBe(false);
  });
});
