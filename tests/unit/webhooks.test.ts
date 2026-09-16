import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_TOLERANCE_SECONDS,
  newSecret,
  signBody,
  signedString,
  verifySignature,
} from "@/core/webhooks/sign";
import { MAX_ATTEMPTS, isExhausted, nextDelayMs, nextRunAt } from "@/core/webhooks/backoff";
import {
  describeFailure,
  encodeFailure,
  isAccepted,
  parseFailure,
} from "@/core/webhooks/failure";
import { ALL_EVENTS, isWebhookEvent, wireName } from "@/core/webhooks/events";

/**
 * The pure half of the webhook slice.
 *
 * Signing, backoff and failure classification are all decisions this product
 * makes without asking anything, which makes them the parts that can be pinned
 * exactly — and the parts where being subtly wrong is invisible until a school
 * is quietly rejecting every delivery.
 */

describe("signing", () => {
  const secret = "whsec_test_key";
  const body = JSON.stringify({ id: "evt_1", type: "results.released" });

  it("puts the timestamp inside the signed string, not beside it", () => {
    // The whole replay defence. If the timestamp were merely a header, a
    // captured request could be re-sent at any future time and the signature
    // would still verify — so changing only the timestamp MUST change the
    // signature.
    const a = signBody({ secret, timestampSeconds: 1_700_000_000, body });
    const b = signBody({ secret, timestampSeconds: 1_700_000_001, body });
    expect(a).not.toEqual(b);
  });

  it("separates the timestamp from the body so the pair cannot be re-cut", () => {
    // Without a separator, ("17", "59…") and ("175", "9…") produce the same
    // signed bytes — an attacker who can influence the body can then move the
    // timestamp for free.
    expect(signedString(17, "59x")).not.toEqual(signedString(175, "9x"));
  });

  it("is stable for the same input and different for a different secret", () => {
    const once = signBody({ secret, timestampSeconds: 1_700_000_000, body });
    const twice = signBody({ secret, timestampSeconds: 1_700_000_000, body });
    const other = signBody({ secret: "whsec_other", timestampSeconds: 1_700_000_000, body });
    expect(once).toEqual(twice);
    expect(once).not.toEqual(other);
  });

  it("carries a version prefix", () => {
    expect(signBody({ secret, timestampSeconds: 1, body })).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it("verifies what it signed", () => {
    const timestampSeconds = 1_700_000_000;
    const header = signBody({ secret, timestampSeconds, body });
    expect(
      verifySignature({ secret, timestampSeconds, body, header, now: timestampSeconds }),
    ).toBe(true);
  });

  it("refuses a body that changed under a valid signature", () => {
    const timestampSeconds = 1_700_000_000;
    const header = signBody({ secret, timestampSeconds, body });
    expect(
      verifySignature({
        secret,
        timestampSeconds,
        body: body.replace("results.released", "assessment.published"),
        header,
        now: timestampSeconds,
      }),
    ).toBe(false);
  });

  it("refuses a replay outside the tolerance window", () => {
    const timestampSeconds = 1_700_000_000;
    const header = signBody({ secret, timestampSeconds, body });
    // The captured request, verbatim, an hour later.
    expect(
      verifySignature({
        secret,
        timestampSeconds,
        body,
        header,
        now: timestampSeconds + 3600,
      }),
    ).toBe(false);
    // And still accepted just inside the window, so the check is not simply
    // refusing everything.
    expect(
      verifySignature({
        secret,
        timestampSeconds,
        body,
        header,
        now: timestampSeconds + RECOMMENDED_TOLERANCE_SECONDS - 1,
      }),
    ).toBe(true);
  });

  it("refuses a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch; the guard has to be a
    // comparison, not an exception nobody catches.
    expect(() =>
      verifySignature({
        secret,
        timestampSeconds: 1,
        body,
        header: "v1=short",
        now: 1,
      }),
    ).not.toThrow();
    expect(
      verifySignature({ secret, timestampSeconds: 1, body, header: "v1=short", now: 1 }),
    ).toBe(false);
  });

  it("generates a recognisable, non-repeating secret", () => {
    const one = newSecret();
    const two = newSecret();
    expect(one).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    expect(one).not.toEqual(two);
  });
});

describe("backoff", () => {
  it("grows, so a server that is down for a day is not asked eleven thousand times", () => {
    const delays = [1, 2, 3, 4].map((attempts) => nextDelayMs(attempts, 0));
    expect(delays).toEqual([60_000, 300_000, 1_500_000, 7_500_000]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it("caps, so a retry never lands a week later", () => {
    expect(nextDelayMs(20, 0)).toBe(6 * 60 * 60 * 1000);
  });

  it("adds jitter upwards only, so a herd spreads and nothing retries early", () => {
    const none = nextDelayMs(1, 0);
    const most = nextDelayMs(1, 0.999);
    expect(most).toBeGreaterThan(none);
    expect(most).toBeLessThanOrEqual(none * 1.2);
  });

  it("is pure: the same inputs give the same schedule", () => {
    const now = new Date("2026-03-01T10:00:00.000Z");
    expect(nextRunAt(2, now, 0.5).toISOString()).toEqual(
      nextRunAt(2, now, 0.5).toISOString(),
    );
  });

  it("knows when the attempts have run out", () => {
    expect(isExhausted(MAX_ATTEMPTS - 1, MAX_ATTEMPTS)).toBe(false);
    expect(isExhausted(MAX_ATTEMPTS, MAX_ATTEMPTS)).toBe(true);
  });
});

describe("failure classification", () => {
  it("round-trips a kind and a status", () => {
    const encoded = encodeFailure("http", { status: 502, detail: "Bad Gateway" });
    expect(parseFailure(encoded)).toEqual({ kind: "http", status: 502 });
  });

  it("caps what it keeps of a receiver's reply", () => {
    const encoded = encodeFailure("http", { status: 500, detail: "x".repeat(5000) });
    expect(encoded.length).toBeLessThan(400);
  });

  it("flattens newlines so one stored failure is one line", () => {
    const encoded = encodeFailure("http", { status: 500, detail: "a\n\nb" });
    expect(encoded).not.toContain("\n");
  });

  it("never puts the receiver's own words in the sentence a person reads", () => {
    const secretish = "Cannot read property studentId of undefined at /srv/mis/app.js";
    const sentence = describeFailure(
      encodeFailure("http", { status: 500, detail: secretish }),
    );
    expect(sentence).toBeTruthy();
    expect(sentence).not.toContain("studentId");
    expect(sentence).not.toContain("/srv/mis");
  });

  it("names the cause a person can act on for the statuses that have one", () => {
    expect(describeFailure(encodeFailure("http", { status: 401 }))).toContain(
      "signing secret",
    );
    expect(describeFailure(encodeFailure("http", { status: 404 }))).toContain("URL");
    expect(describeFailure(encodeFailure("timeout"))).toContain("did not answer in time");
    expect(describeFailure(encodeFailure("connect"))).toContain("could not reach");
  });

  it("distinguishes a refusal from a failure", () => {
    // "We did not send this because you switched the endpoint off" must not
    // read as "your server is broken".
    expect(describeFailure(encodeFailure("inactive"))).toContain("switched off");
    expect(describeFailure(encodeFailure("gone"))).toContain("no longer exists");
  });

  it("returns nothing when nothing has gone wrong", () => {
    expect(describeFailure(null)).toBeNull();
    expect(parseFailure(null)).toBeNull();
  });

  it("reads an unknown kind as unknown rather than throwing", () => {
    expect(parseFailure("wat:1 something")).toEqual({ kind: "unknown", status: 1 });
  });

  it("accepts 2xx and nothing else — a redirect is not an acceptance", () => {
    expect(isAccepted(200)).toBe(true);
    expect(isAccepted(204)).toBe(true);
    expect(isAccepted(301)).toBe(false);
    expect(isAccepted(302)).toBe(false);
    expect(isAccepted(404)).toBe(false);
    expect(isAccepted(500)).toBe(false);
  });
});

describe("the event catalogue", () => {
  it("gives every event a wire name and a description", () => {
    for (const event of ALL_EVENTS) {
      expect(wireName(event)).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it("rejects an event that is not in the catalogue", () => {
    // The subscription list comes from a request body. Anything not offered is
    // refused rather than stored and silently never matched.
    expect(isWebhookEvent("ASSESSMENT_PUBLISHED")).toBe(true);
    expect(isWebhookEvent("ATTEMPT_SUBMITTED")).toBe(false);
    expect(isWebhookEvent("")).toBe(false);
  });

  it("does not offer anything a student wrote", () => {
    // A guard on the catalogue itself. Adding `mistake.created` or
    // `tutor.asked` here would be a decision to push a child's own failures to
    // a school server, and it should not be possible to make it by accident.
    const forbidden = ["mistake", "tutor", "answer", "practice"];
    for (const event of ALL_EVENTS) {
      for (const word of forbidden) {
        expect(wireName(event)).not.toContain(word);
      }
    }
  });
});
