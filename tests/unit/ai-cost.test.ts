import { afterEach, describe, expect, it } from "vitest";
import { costMicros, modelFor, uncachedCostMicros } from "@/ai/models";
import { defaultLimitMicros, windowFor } from "@/ai/budget";

afterEach(() => {
  delete process.env.AI_MODEL_BALANCED;
  delete process.env.AI_BUDGET_MONTH_MICROS;
});

describe("tiers to models", () => {
  it("maps a tier to a model, and never the other way round", () => {
    // Business logic names a tier. Only this layer names a model, so changing
    // which model serves BALANCED is an environment change rather than a
    // deploy of new business code.
    expect(modelFor("FAST").id).toBe("claude-haiku-4-5");
    expect(modelFor("BALANCED").id).toBe("claude-sonnet-5");
    expect(modelFor("DEEP").id).toBe("claude-opus-5");
  });

  it("lets an operator move a tier without a release", () => {
    process.env.AI_MODEL_BALANCED = "claude-sonnet-5-some-later-snapshot";
    expect(modelFor("BALANCED").id).toBe("claude-sonnet-5-some-later-snapshot");
    // The price and the timeout stay with the tier, not with the id.
    expect(modelFor("BALANCED").outputPerMTok).toBe(10);
  });

  it("gives a deeper tier a longer rope", () => {
    expect(modelFor("DEEP").timeoutMs).toBeGreaterThan(modelFor("FAST").timeoutMs);
  });
});

describe("what a call costs", () => {
  it("bills input and output at their own rates", () => {
    // 1M input + 1M output on BALANCED: $2 + $10 = $12 = 12,000,000 micros.
    const micros = costMicros("BALANCED", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
    });
    expect(micros).toBe(12_000_000);
  });

  it("bills a cached prefix at a tenth", () => {
    const cached = costMicros("BALANCED", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    // $2.00 becomes $0.20. This is the number that makes the caching
    // discipline worth the trouble.
    expect(cached).toBe(200_000);
  });

  it("reports what the same call would have cost uncached", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 900_000,
    };
    // A caching discipline nobody can measure is one that quietly stops
    // working: cache_read going to zero roughly triples the bill with no other
    // symptom.
    expect(uncachedCostMicros("BALANCED", usage)).toBeGreaterThan(
      costMicros("BALANCED", usage) * 4,
    );
  });

  it("never returns a fraction of a micro", () => {
    const micros = costMicros("FAST", {
      inputTokens: 7,
      outputTokens: 3,
      cachedInputTokens: 0,
    });
    expect(Number.isInteger(micros)).toBe(true);
    // Rounded up. A ledger that under-reports lets a budget be exceeded; one
    // that over-reports by a millionth costs nothing.
    expect(micros).toBeGreaterThan(0);
  });

  it("costs a deep call more than a fast one for the same work", () => {
    const usage = { inputTokens: 10_000, outputTokens: 2_000, cachedInputTokens: 0 };
    expect(costMicros("DEEP", usage)).toBeGreaterThan(costMicros("FAST", usage));
  });

  it("prices the modelled 40-question generation near the documented figure", () => {
    // AI_ARCHITECTURE section 8 models this at about $0.20 on BALANCED. The
    // point of the assertion is that the arithmetic here and the figure the
    // product plans around have not silently diverged.
    const micros = costMicros("BALANCED", {
      inputTokens: 30_000,
      outputTokens: 16_000,
      cachedInputTokens: 24_000,
    });
    expect(micros).toBeGreaterThan(100_000);
    expect(micros).toBeLessThan(300_000);
  });
});

describe("budget windows", () => {
  it("runs a month from the first to the first", () => {
    const { start, end } = windowFor("MONTH", new Date("2026-09-08T14:00:00Z"));
    expect(start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rolls a month over a year boundary", () => {
    const { end } = windowFor("MONTH", new Date("2026-12-20T00:00:00Z"));
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("runs a day from midnight to midnight", () => {
    const { start, end } = windowFor("DAY", new Date("2026-09-08T23:59:00Z"));
    expect(start.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-09T00:00:00.000Z");
  });

  it("keeps a day's ceiling under a month's", () => {
    // A single bad afternoon must not be able to spend the month.
    expect(defaultLimitMicros("DAY")).toBeLessThan(defaultLimitMicros("MONTH"));
  });

  it("lets an operator set the ceiling", () => {
    process.env.AI_BUDGET_MONTH_MICROS = "50000000";
    expect(defaultLimitMicros("MONTH")).toBe(50_000_000);
  });
});
