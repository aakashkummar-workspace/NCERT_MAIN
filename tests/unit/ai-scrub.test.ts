import { describe, expect, it } from "vitest";
import {
  checkForLeaks,
  opaqueId,
  scrub,
  UnsafeField,
} from "@/ai/scrub";
import { randomUUID } from "node:crypto";
import { textToken } from "../integration/support/text-token";

describe("what leaves for a model", () => {
  it("keeps only what the caller declared safe", () => {
    const out = scrub(
      {
        conceptId: "c-1",
        difficulty: "HARD",
        fullName: "Arun Kumar",
        phone: "9876543210",
      },
      ["conceptId", "difficulty"],
    );

    expect(out).toEqual({ conceptId: "c-1", difficulty: "HARD" });
    expect(Object.keys(out)).not.toContain("fullName");
    expect(Object.keys(out)).not.toContain("phone");
  });

  it("drops a field nobody thought about", () => {
    // The reason this is an allow-list and not a deny-list. A deny-list ships
    // whatever the next feature adds, and nothing anywhere says so.
    const out = scrub(
      { conceptId: "c-1", guardianWhatsApp: "9876543210", notes: "lives near the temple" },
      ["conceptId"],
    );
    expect(out).toEqual({ conceptId: "c-1" });
  });

  it("refuses to send a name even when a caller asks for it", () => {
    // The second lock. A caller declaring "fullName" has misunderstood
    // something, and quietly dropping it leaves them thinking it worked.
    expect(() => scrub({ fullName: "Arun" }, ["fullName"])).toThrow(UnsafeField);
    expect(() => scrub({ phone: "9876543210" }, ["phone"])).toThrow(UnsafeField);
    expect(() => scrub({ email: "a@b.c" }, ["email"])).toThrow(UnsafeField);
  });

  it("strips identifying fields nested inside an allowed one", () => {
    const out = scrub(
      {
        cohort: {
          size: 24,
          students: [
            { id: "S_1", fullName: "Arun Kumar", estimate: 0.7 },
            { id: "S_2", phone: "9876543210", estimate: 0.4 },
          ],
        },
      },
      ["cohort"],
    );

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("Arun");
    expect(serialised).not.toContain("9876543210");
    // What is genuinely useful survives.
    expect(serialised).toContain("0.7");
    expect(serialised).toContain("S_1");
  });

  it("keeps dates and numbers usable", () => {
    const out = scrub(
      { when: new Date("2026-09-08T00:00:00Z"), score: 0.75, ok: true, missing: NaN },
      ["when", "score", "ok", "missing"],
    );
    expect(out.when).toBe("2026-09-08T00:00:00.000Z");
    expect(out.score).toBe(0.75);
    expect(out.ok).toBe(true);
    // NaN is not a number a model can use, and JSON has no way to say it.
    expect(out.missing).toBeNull();
  });
});

describe("opaque identifiers", () => {
  it("is stable for the same id", () => {
    expect(opaqueId("S", "abc-123")).toBe(opaqueId("S", "abc-123"));
  });

  it("distinguishes two students", () => {
    expect(opaqueId("S", "abc-123")).not.toBe(opaqueId("S", "abc-124"));
  });

  it("carries nothing about the person", () => {
    const token = opaqueId("S", "3f8a9c21-0000-4000-8000-000000000000");
    expect(token).toMatch(/^S_[0-9a-f]{6}$/);
    expect(token).not.toContain("3f8a9c21");
  });
});

describe("the last look before the prompt leaves", () => {
  it("catches an email a template interpolated", () => {
    // Belt and braces over scrub(). A prompt is assembled from template
    // strings, and a template is exactly where a name gets interpolated
    // without going through a scrubbed payload at all.
    const check = checkForLeaks("Write a question for arun.kumar@example.com");
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.kind).toBe("email");
  });

  it("catches an Indian mobile number", () => {
    const check = checkForLeaks("The student on 9876543210 needs practice.");
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.kind).toBe("phone");
  });

  it("does not fire on ordinary maths", () => {
    // Conservative on purpose. A checker that rejected "Pythagoras" or a
    // ten-digit answer would be turned off within a week.
    for (const text of [
      "In triangle ABC, AB = 6 cm and BC = 8 cm. Find AC.",
      "The population grew from 1234567890 to twice that.",
      "Pythagoras, Euclid and Thales walk into a bar.",
      "Concept C_4f2a, student S_7f3a, estimate 0.62",
    ]) {
      expect(checkForLeaks(text).ok).toBe(true);
    }
  });
  // Why integration tests put textToken(), never randomUUID(), in question
  // text: about one UUID in three hundred holds ten digits starting 6-9, the
  // check refuses the prompt, and a test fails once in a few hundred runs.
  it("a random UUID can look like a mobile number, and a test token cannot", () => {
    const uuids = Array.from({ length: 20_000 }, () => `Stem ${randomUUID()}`);
    expect(uuids.some((text) => !checkForLeaks(text).ok)).toBe(true);
    for (let i = 0; i < 20_000; i++) {
      expect(checkForLeaks(`Stem ${textToken()}`).ok).toBe(true);
    }
  });
});
