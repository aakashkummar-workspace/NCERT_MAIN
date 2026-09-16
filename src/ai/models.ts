/**
 * Tiers to models, and models to money.
 *
 * ---------------------------------------------------------------------------
 * Business logic names a TIER. Only this file names a model.
 * ---------------------------------------------------------------------------
 * A feature asks for `BALANCED`. Which model that is today is configuration —
 * an environment variable and a row in `prompt_versions`, not a deploy. A model
 * id hard-coded in a route handler is how a cost decision, a quality decision
 * and a migration all become one code change nobody wants to make.
 *
 * Prices are per million tokens, in US dollars, as published on 2026-09-07.
 * They live beside the tier because a tier without its price is a choice made
 * with the cost hidden.
 */

export type ModelTier = "FAST" | "BALANCED" | "DEEP";

export type ModelConfig = {
  id: string;
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /**
   * Reading a cached prefix costs a tenth of writing it. This is the number
   * that makes the caching discipline in AI_ARCHITECTURE section 4 worth the
   * trouble.
   */
  cachedInputPerMTok: number;
  /** A hung call is a failed call. Per tier, because depth costs time. */
  timeoutMs: number;
};

/**
 * The default mapping. Overridden per tier by `AI_MODEL_FAST`,
 * `AI_MODEL_BALANCED` and `AI_MODEL_DEEP` — an operator can move a tier to a
 * different model without a release.
 */
const DEFAULTS: Record<ModelTier, ModelConfig> = {
  // Classification, tagging, short extraction. High volume, low judgement.
  FAST: {
    id: "claude-haiku-4-5",
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cachedInputPerMTok: 0.1,
    timeoutMs: 30_000,
  },
  // Question generation, validation, narratives, tutor turns.
  BALANCED: {
    id: "claude-sonnet-5",
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cachedInputPerMTok: 0.2,
    timeoutMs: 120_000,
  },
  // Anything a teacher will act on across a whole cohort. Deliberately chosen
  // where quality matters more than cost, not used by default.
  DEEP: {
    id: "claude-opus-5",
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cachedInputPerMTok: 0.5,
    timeoutMs: 180_000,
  },
};

export function modelFor(tier: ModelTier): ModelConfig {
  const override = process.env[`AI_MODEL_${tier}`];
  const base = DEFAULTS[tier];
  return override ? { ...base, id: override } : base;
}

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

/**
 * What a call cost, in millionths of a dollar.
 *
 * An integer, because money in a floating-point number is how a ledger stops
 * adding up. Rounded up: a ledger that under-reports is worse than one that
 * over-reports by a millionth, because the first one lets a budget be exceeded.
 */
export function costMicros(tier: ModelTier, usage: TokenUsage): number {
  const model = modelFor(tier);
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);

  const dollars =
    (fresh * model.inputPerMTok) / 1_000_000 +
    (usage.cachedInputTokens * model.cachedInputPerMTok) / 1_000_000 +
    (usage.outputTokens * model.outputPerMTok) / 1_000_000;

  return Math.ceil(dollars * 1_000_000);
}

/**
 * What the same call would have cost with no cache hit.
 *
 * Reported so the saving is visible. A caching discipline nobody can measure is
 * a caching discipline that quietly stops working — `cache_read_input_tokens`
 * silently going to zero roughly triples the bill with no other symptom.
 */
export function uncachedCostMicros(tier: ModelTier, usage: TokenUsage): number {
  return costMicros(tier, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: 0,
  });
}
