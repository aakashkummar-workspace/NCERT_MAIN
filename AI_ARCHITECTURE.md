# AI Architecture

Model IDs, context windows and prices in this document are the current published
Anthropic API values (checked 2026-09-07). Cost figures are **modelled, not measured** —
the first week of real traffic replaces them.

## 1. The rule everything else follows

> **AI proposes. The database decides. A human approves anything a student will see.**

Three consequences that shape the code:

1. **No AI output is authoritative.** A generated question is a `DRAFT` row until a teacher approves it. A tutor explanation is rendered beside the stored answer key and may not contradict it.
2. **No AI call is on a blocking path.** Scoring, results and analytics work with the provider entirely offline.
3. **Every AI call is a typed task with a schema.** A free-form string response that some caller then parses with a regex is prohibited.

## 2. Layers

```
  Feature code  (core/, app/)
        │  calls a task, never a provider
        ▼
  ┌──────────────────────────────────────────────────┐
  │  AI Tasks                                        │
  │    QuestionGenerator   QuestionValidator         │
  │    PerformanceAnalyst  MistakeClassifier         │
  │    StudentTutor        TeacherCopilot            │
  │    ReportWriter        RecommendationRanker      │
  └──────────────────────┬───────────────────────────┘
                         ▼
  ┌──────────────────────────────────────────────────┐
  │  AIGateway                                       │
  │   entitlement → budget → PII scrub → prompt      │
  │   assembly → call → schema validate → repair or  │
  │   refuse → usage log → audit                     │
  └──────────────────────┬───────────────────────────┘
                         ▼
  ┌──────────────────────────────────────────────────┐
  │  ModelRouter    tier → model id, from config      │
  └──────────────────────┬───────────────────────────┘
                         ▼
  ┌──────────────────────────────────────────────────┐
  │  AIProvider (interface)                          │
  │     AnthropicProvider  │  MockProvider (tests)   │
  └──────────────────────────────────────────────────┘
```

Feature code may not import the provider or the SDK. Enforced by lint rule — one
direct `new Anthropic()` in a route handler is how model choice, budget and PII
scrubbing all get bypassed at once.

```ts
interface AIProvider {
  complete<T>(req: AIRequest<T>): Promise<AIResult<T>>;
}

interface AIRequest<T> {
  tier: 'FAST' | 'BALANCED' | 'DEEP';
  feature: AIFeature;
  system: string;
  messages: MessageParam[];
  schema: ZodSchema<T>;        // structured output, always
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  cacheablePrefix?: string;
}
```

## 3. Model strategy

Three tiers, mapped to models **in configuration, never in business logic**. Changing a
tier's model is an environment change and a row in `prompt_versions`, not a deploy of
new code.

| Tier | Model | Price in / out per MTok | Used for |
|---|---|---|---|
| `FAST` | `claude-haiku-4-5` | $1.00 / $5.00 | Classification, tagging, mistake typing, short extraction — high volume, low judgement |
| `BALANCED` | `claude-sonnet-5` | $2.00 / $10.00 | Question generation, validation, narratives, tutor turns, reports |
| `DEEP` | `claude-opus-5` | $5.00 / $25.00 | Teacher Copilot, multi-class analysis, anything a teacher will act on across a whole cohort |

*(This tiering is a deliberate, instructed cost decision, not a default. Where quality
matters more than cost — Copilot, and the first generation of any new question type —
the deep tier is used.)*

**API specifics that matter:**

- Adaptive thinking (`thinking: { type: 'adaptive' }`) on Sonnet 5 and Opus 5. `budget_tokens` is rejected by these models; it belongs to an older API generation.
- Depth is tuned with `output_config.effort`, not by switching model. `low` for classification, `high` for generation, `xhigh` for Copilot analysis.
- **Structured output on every call**: `output_config.format` with a JSON schema, plus a Zod parse on our side. Never a prompt that says "reply only with JSON".
- **Streaming** for anything with a large `max_tokens`, to avoid HTTP timeouts.
- **`stop_reason: 'refusal'` is checked before reading content** on Opus 5, with server-side fallbacks enabled. A refusal is a `REFUSED` generation record, never a crash and never an empty question.
- **Batch API (50% discount)** for anything not latency-bound: overnight report generation, bulk re-validation, backfilling item statistics.

## 4. Prompt caching — the largest cost lever

Curriculum context is long, identical across calls and changes rarely. It is cached.

Prefix order is `tools → system → messages`, and a single byte changed anywhere in the
prefix invalidates everything after it. So:

```
  [ cached ]  System: role, rules, output contract          ~1,200 tok
  [ cached ]  Curriculum: chapter, topics, outcomes         ~1,800 tok
  [ cached ]  Exemplars: 3 approved questions, same style   ~1,000 tok
  ── cache breakpoint ─────────────────────────────────────────────
  [ fresh  ]  This request: blueprint slice, avoid-list       ~300 tok
```

Never place a timestamp, a request id or an unsorted JSON blob above the breakpoint.
**`usage.cache_read_input_tokens` is asserted in tests**: if it is zero across repeated
generations, a silent invalidator has been introduced and the bill has roughly tripled
without any visible symptom.

## 5. Question generation pipeline

Generation is a pipeline with a validation gate, not one prompt.

```
  1. RESOLVE    blueprint → learning_outcome ids, marks, difficulty targets
  2. RETRIEVE   existing approved questions for those outcomes
                → few-shot exemplars, and an explicit avoid-list
  3. GENERATE   batches of ~6, grouped by outcome, structured output
  4. VALIDATE   every item, independently (§6)
  5. DEDUPE     exact by content_hash; near by embedding cosine > 0.92
  6. REPAIR     one regeneration attempt for a failed item, then drop it
  7. PERSIST    DRAFT + per-item validation report
  8. REPORT     "10 of 12 generated. 2 dropped: duplicate, ambiguous answer."
```

**Partial success is a first-class outcome.** `ai_generations.status` has a `PARTIAL`
value and the UI is built for it. A pipeline that must return exactly what was asked
for will eventually pad the result with a bad question, and one bad question in a real
exam costs more trust than ten missing ones.

### Grounding

Every generated question must carry:

- a `learning_outcome_id` it was generated against,
- the chapter scope it was constrained to,
- the `prompt_version` that produced it.

A question that cannot state which outcome it tests cannot inform mastery, and is
rejected before a human ever reviews it.

## 6. Validation — the part that decides whether any of this is usable

Runs on the `FAST` tier plus deterministic checks. Cheap, and it is what makes
generation safe to offer.

| Check | Method | Failure |
|---|---|---|
| Schema conformance | Zod | Reject |
| Exactly one correct option (MCQ) | Deterministic | Reject |
| Options mutually exclusive, none "all of the above" | Model + rule | Flag |
| Distractors plausible and distinct | Model | Flag |
| Answer derivable from the stem alone | Model | Flag |
| Within chapter scope | Model, against outcome text | Reject |
| No answer leakage in the stem | Model | Reject |
| Reading level appropriate to Class 9/10 | Model | Flag |
| Duplicate of an existing item | Hash + embedding | Reject |
| Marks consistent with type and difficulty | Deterministic | Flag |

**Reject** never reaches a teacher. **Flag** reaches the teacher with the reason shown
on the question card. The teacher is the last gate, and the product's job is to make
that gate cheap to operate — not to remove it.

## 7. Privacy

**No student name, phone number, email or school name is ever sent to a model.**

Prompts carry opaque identifiers:

```
  student: S_7f3a          not  "Arun Kumar"
  class:   C_10A           not  "Sunrise Public School, Class 10-A"
```

The mapping stays in our database and is re-applied when rendering. A leaked prompt
log, or a provider incident, must not be a student-data incident.

What is sent: concept ids, mastery estimates, item difficulty, correctness patterns.
What is never sent: identity, contact details, free-text a student wrote about
themselves, or anything from another organization.

`ai_generations.input_summary` stores the *scrubbed* payload only. Debugging comfort is
not a reason to keep the unscrubbed one.

## 8. Cost control

Enforced in the gateway, before the call:

```
  entitlement check   plan allows this feature at all?
  org budget          monthly micros remaining?
  feature budget      per-feature sub-limit?
  user rate limit     token bucket, per user per feature
  concurrency         per-org cap on in-flight generations
  timeout             per tier; a hung call is a failed call
  retries             max 2, exponential backoff, jittered
```

Every call writes an `ai_usage` row **including failures and refusals**. A retry storm
is invisible in a success-only ledger, and that invisibility is what produces a
surprise bill.

### Modelled cost

Per operation:

| Operation | Tier | Cost |
|---|---|---|
| Generate a 40-question assessment | BALANCED | **$0.20** |
| The same on DEEP | DEEP | $0.50 |
| Validate 40 questions | FAST | $0.041 |
| Class insight narrative | BALANCED | $0.014 |
| Classify one mistake | FAST | $0.0010 |
| One tutor turn | BALANCED | $0.0084 |
| One concept drafting run | BALANCED | $0.03 |
| One Copilot turn | DEEP | $0.042 |
| One parent term report | BALANCED | $0.015 |

Monthly, for one institute — 300 students, 12 teachers, 4 assessments per teacher,
6 attempts per student:

| Line | Cost | Share |
|---|---|---|
| Mistake classification | $13.82 | 27.3% |
| Student tutor | $10.08 | 19.9% |
| Teacher copilot | $10.08 | 19.9% |
| Question generation | $9.61 | 19.0% |
| Parent reports | $4.35 | 8.6% |
| Question validation | $1.97 | 3.9% |
| Class insights | $0.65 | 1.3% |
| **Total** | **$50.56** | |

**$0.17 per student per month.** Running everything on the deep tier instead would be
roughly $126 — the tiering is worth about 60% of the bill.

**The most important number here is the top line.** Mistake classification is the
largest cost not because it is expensive but because it runs per wrong answer, and
volume beats unit price every time. Two mitigations, both taken:

1. An unattempted answer, a timing-out answer and an option-order slip are classified by **rule, at zero cost**. Only genuinely ambiguous cases reach a model.
2. Classification is **batched nightly through the Batch API** at 50%, not run per submission. Nothing in the product needs a mistake typed within the second.

Applied, that line drops to roughly $3–4 and the total to about **$40/month per
institute**, or **$0.13 per student**.

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Provider timeout | Job retries with backoff; teacher sees "still working", never a spinner that lies |
| Invalid JSON / schema mismatch | One repair attempt, then the item is dropped and counted in `PARTIAL` |
| `stop_reason: refusal` | Logged as `REFUSED` with category; server-side fallback attempted once |
| Budget exhausted | Feature disabled with an honest message and an upgrade path — never a silent downgrade to a worse model |
| Partial generation | Teacher gets what succeeded, plus a count and a reason for what did not |
| Provider outage | Every non-AI path continues. Dashboards render. Tests score. Only the prose is missing. |

## 10. Evaluation

Shipping a generator with no eval set is shipping an opinion.

- **Golden set**: 200 human-reviewed questions across subjects, chapters and difficulty, with expert verdicts.
- **Generation eval**: teacher-approval rate on first draft. **Target ≥ 70%.** Below that, generation costs a teacher more time than manual writing and the feature is a liability rather than an asset.
- **Validation eval**: precision and recall against the golden set. Recall on "reject" matters more than precision — a bad question that reaches a student is far worse than a good one that got flagged.
- **Regression gate**: any prompt or model change re-runs the eval before it can be marked active in `prompt_versions`.

Prompts are versioned rows, not string literals in the source. A model or prompt change
that moves approval rate is then attributable to a specific version — otherwise
"generation got worse this month" is unanswerable.

## 11. What AI is deliberately not used for

- **Scoring objective questions.** Deterministic, from the stored key. Always.
- **Computing mastery.** A statistical estimator, auditable and reproducible. A model asked to "estimate mastery" produces a plausible number with no evidence behind it, which is the exact failure this product exists to avoid.
- **Deciding who needs attention.** Thresholds over data, so the rule can be shown to a teacher and argued with.
- **Writing the answer key.** Generated together with the question, then validated, then human-approved — never regenerated later against a student's answer.
