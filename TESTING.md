# Testing Strategy

Test where a bug is expensive, not where it is easy. A bug in the mastery estimator
tells a teacher to re-teach the wrong chapter for a month. A bug in a card's padding
does not.

## 1. The pyramid, weighted for this product

| Layer | Tool | Count | What it covers |
|---|---|---|---|
| Unit | Vitest | ~400 | Scoring, mastery, gaps, blueprint, entitlements, policy predicates |
| Integration | Vitest + real Postgres | ~120 | Repositories, RLS, transactions, job handlers |
| Contract | Vitest | ~60 | Zod schemas on every route; AI output schemas |
| E2E | Playwright | ~30 | The thirteen flows in §4 |
| Visual | Playwright screenshots | ~20 | Design system components in all states, both themes |
| Data | Custom validators | ~15 | Curriculum integrity, question bank quality |

**Integration tests run against a real Postgres**, in Docker, with migrations applied.
An in-memory substitute cannot exercise RLS, and RLS is the tenancy mechanism —
mocking the database means never testing the thing that keeps schools apart.

## 2. Unit tests — where the product's judgement lives

### Scoring
Every question type; partial credit; negative marking; unanswered vs wrong (**an
unanswered question scores 0, an ungraded one scores `null`, and no code path may
conflate them**); multi-select partials; numeric tolerance; case and whitespace in
fill-in-the-blank.

### Mastery estimator
The highest-value test file in the repository.

- A single correct answer does not produce mastery `1.0`.
- Below `MIN_EVIDENCE`, the band is `INSUFFICIENT` and no estimate is exposed.
- A hard item correct moves the estimate more than an easy item correct.
- Recency decay: ten correct answers in July and three wrong in December yield a declining trend.
- Recomputing from `concept_evidence` reproduces the stored estimate exactly. **Property-based**, over generated evidence sequences — this is the invariant that lets the algorithm change later without silently rewriting history.
- Order independence where the model claims it, order dependence where it claims that.

### Gap detection
Threshold boundaries; a gap needs enough affected students *and* enough evidence per
student; root-cause traversal of `concept_prerequisites` terminates on a cyclic graph;
`RESOLVED` requires new evidence and never a timer.

### Authorization
A table-driven test over the full matrix in `SECURITY_MODEL.md` §2, with a
**deny-by-default assertion**: any `(role, action, resource)` triple not explicitly
allowed must be denied. A new resource type therefore starts locked, and adding one
without a policy fails the suite rather than shipping open.

### Blueprint
Marks sum to total; difficulty mix sums to 100%; the requested count is satisfiable
from the available outcomes; an incompatible edit after generation reports exactly what
would be dropped.

## 3. Integration tests

### Tenancy — the suite that must never be skipped

For **every** tenant table, a generated test:

```
  Given org A and org B, each with one row
  When the session context is org A
  Then a query returns exactly A's row, and B's row is invisible
  And an explicit `where id = B.id` returns nothing
  And an insert carrying B's organization_id is rejected by the WITH CHECK policy
```

Generated from `information_schema`, not hand-written per table. A new table with no
RLS policy fails this suite the day it is added — which is the only reliable way to
keep the guarantee true after month three.

Plus: `set_config` is transaction-local (two sequential transactions on one pooled
connection do not leak context); `force row level security` is on for every tenant
table; `withTenant()` is the only path to the client.

### Attempt lifecycle
Idempotent creation; answers apply last-write-wins by `clientSeq`; out-of-order batches
converge; submit is idempotent; late submit is marked not rejected; the abandoned sweep
submits with `SWEEP`; a concurrent double submit produces one attempt (run with real
parallel transactions, not sequentially).

### Jobs
Claim is exclusive under concurrency; a crashed worker's lease is reclaimed after
expiry; `max_attempts` exhaustion goes `DEAD` and alerts; the dedupe key prevents a
duplicate enqueue; the outbox drains at-least-once and handlers are idempotent.

## 4. E2E — the thirteen flows

**Built.** `e2e/`, run with `npm run test:e2e`, and wired into CI after the smoke
suite. Each flow builds its own organisation against a real build — nothing
depends on seed state, because the database is shared and never reset.

The suite deliberately does NOT re-test what the HTTP smoke checks already
cover. It exists for what only a browser can prove: work surviving a refresh or
a dropped connection, keyboard operation, axe violations, and layout at 360px.

Two real product bugs were found by writing it — a race in `startAttempt` that
told a student "we could not reach the server" while their paper had in fact
started, and a per-question figure printed directly above its own sentence
saying there was no figure yet. Both are fixed and both are now ordinary
assertions.

Each runs against a seeded database on a real build.

1. Teacher signs up → organization created
2. Creates a class
3. Adds students by paste, and by CSV with a deliberate bad row
4. Creates a question manually
5. Generates questions with AI (mock provider) → drafts appear with verdicts
6. Builds an assessment through all six steps
7. Publishes and assigns
8. Student signs in and sees the assignment
9. Student takes the test: answers, marks for review, navigates, refreshes mid-test and **loses nothing**
10. Student submits → sees a score
11. Teacher sees results; releases them
12. Analytics show mastery, and show `INSUFFICIENT` where evidence is thin
13. A gap is detected → remedial test created in one click → baseline stamped

Flow 9 has three variants: refresh, offline-then-online, and timer expiry with the tab
backgrounded. They are the three ways real students lose real work.

## 5. Edge cases — each one a named test

| Case | Expected |
|---|---|
| Double submit | One attempt, one score, second returns the first |
| Timer expires while offline | Auto-submits on reconnect, flagged `TIMEOUT`, answers preserved |
| Network drops mid-test | Queue in IndexedDB, sync on return, nothing lost |
| Refresh mid-test | State restored, clock correct (derived, not restarted) |
| Session expires mid-test | Answers stay queued; re-auth resumes the same attempt |
| Question deleted after assignment | Published version is frozen; the paper is unaffected |
| Assessment edited after an attempt | 409 with an explanation and a "duplicate" action |
| AI returns invalid JSON | One repair, then dropped, counted in `PARTIAL` |
| AI returns a question with two correct options | Validator rejects; never reaches a teacher |
| AI times out | Job retries; partial results kept |
| Cross-tenant read by id | 404, and an audit row |
| Parent opens an unreleased result | 403 with a human message |
| Student opens another student's attempt | 404 |
| Teacher opens a class they do not teach | 404 |
| Two teachers edit one assessment | Optimistic concurrency, 409, no silent overwrite |
| CSV with duplicate roll numbers | Row-level errors, valid rows still imported |
| Student in two classes for one subject | Both assignments visible, mastery unified |
| Mastery with 1 evidence item | `INSUFFICIENT`, no number rendered |
| Clock skew of 10 minutes on the client | Server time wins; the student is not penalised |

## 6. AI testing

**No test in CI calls a real model.** `MockProvider` returns fixtures, including the
bad ones: malformed JSON, two correct answers, an out-of-syllabus question, a
duplicate, a refusal, a timeout.

Separately, an **eval suite that does spend real money** and is run deliberately, not
on every commit:

```bash
npm run eval:generation    # approval rate against the golden set, target ≥ 70%
npm run eval:validation    # precision/recall, recall on reject weighted higher
npm run eval:tutor         # does the explanation ever contradict the answer key?
```

The tutor eval matters most. A tutor that contradicts the official key once in a
hundred turns is a support ticket from a parent and a teacher who stops recommending
the product.

A prompt or model change cannot be marked `active` in `prompt_versions` without a
recorded eval run.

## 7. Design QA

Automated:
- Contrast: every token pair asserted against WCAG AA, computed not eyeballed.
- Tap targets: ≥ 44×44px, Playwright over every interactive element on mobile viewports.
- Keyboard: every flow completable without a mouse.
- axe-core on every page, zero violations.
- Visual snapshots of each component in every state, light and dark.

Manual, per screen, before it is called done:
- Does the empty state create something?
- Is there exactly one primary action?
- Does every insight end in a verb?
- Does the error name what survived?
- Does it work at 360px wide?

## 8. Performance budgets — asserted, not aspired to

| Path | Budget |
|---|---|
| Attempt submit (server) | p95 < 400ms |
| Answer autosave | p95 < 200ms |
| Dashboard first load | p95 < 1.5s |
| Analytics query | p95 < 800ms |
| Test player JS bundle | < 180KB gzipped |
| Lighthouse, student app, mid-tier Android | ≥ 90 |

Load test before launch: 200 students submitting inside 60 seconds — the computer-lab
scenario, which is the shape of real traffic and nothing like a smooth ramp.

## 9. CI

```
  lint  →  typecheck  →  unit  →  integration (Postgres service)  →  build
        →  e2e (Playwright)  →  a11y  →  bundle size  →  RLS audit
```

Every stage blocks merge. The RLS audit is last and loudest: it enumerates tenant
tables and fails on any without a forced policy.

## 10. What is deliberately not tested

- Third-party SDK internals.
- Exact prose of AI output — asserted on schema and on constraints ("does not contradict the key"), never on wording.
- Visual pixel-perfection beyond the component snapshots.
- Marketing pages beyond a smoke test and accessibility.
