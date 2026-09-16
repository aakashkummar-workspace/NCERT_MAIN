# Risk Register

Scored **Impact × Likelihood**, both 1–5. Only risks with a real mitigation are listed;
a risk with no owner and no action is a worry, not a risk.

---

## A. Product risks

### Risk 1 — The content cold-start · Impact 5 · Likelihood 5 · **Score 25**

**The highest risk in this plan, by a distance.**

The platform launches with an empty question bank. Every AI feature is grounded in
curriculum and in exemplars — generation quality depends on having approved questions
to few-shot from, and validation depends on having something to deduplicate against.
On day one there is neither.

A predecessor codebase in the adjacent directory holds roughly 2,459 curriculum-mapped,
teacher-reviewable questions across 105 chapters with explanations and difficulty
labels. **The decision has been taken to build clean and not import it.** That decision
is respected here, and it makes this risk larger rather than smaller, so it is named
plainly rather than buried.

Consequences if unmitigated:
- A teacher's first AI generation is unanchored, approval rate lands well below 70%, and the core value proposition fails on first contact — the single worst moment to fail.
- "Browse the question bank" is an empty state during every sales demo.
- Mastery needs evidence across items; a thin bank means thin evidence and `INSUFFICIENT` everywhere, which makes the analytics look broken rather than honest.

**Decision taken (2026-09-07): launch with an empty bank.** No pre-seeded corpus. Teachers
author and generate their own questions from day one. This is the cheapest path to a
running product and the most expensive path to a good first impression, so the
mitigation moves from "seed it" to "make the empty state productive".

**Mitigation, given that decision:**

1. **The empty question bank is a designed surface, not a blank page.** It opens on the
   curriculum tree with a chapter picker and two buttons — write one, or generate a set.
   A teacher's first minute is spent choosing a chapter, not staring at "No data found".
2. **Generation quality without exemplars is the thing to protect.** With no approved
   questions to few-shot from, the generator leans entirely on the curriculum tree, so
   `learning_outcomes.statement` must be written richly enough to carry a prompt on its
   own. That raises the bar on slice 3: outcome statements are prompt material, not
   labels.
3. **A hired freelance CBSE teacher reviews inside the product**, through the same review
   queue the customer will use. Two things follow: the queue gets exercised hard before a
   customer sees it, and the reviewer's approvals become the first exemplars.
4. **The global bank grows organically.** Questions approved by the reviewer, and later
   the highest-rated org questions whose authors opt in, are promoted to `GLOBAL`. The
   corpus becomes an asset over months instead of a purchase up front.
5. **Watch the leading indicator, not the lagging one.** First-draft approval rate is
   measured from the first generation. Below 70% for two consecutive weeks, the decision
   is revisited — importing a curriculum-mapped corpus stays a data-mapping exercise, not
   an architectural one, because the two-plane schema loads one without touching the
   tenant plane.

**Residual risk, stated plainly:** the first demo shows an empty bank, and early
generation will be weaker than it would have been with exemplars. That is the accepted
cost of the decision, not a problem that has been solved.

**Owner:** Product. **Trigger to escalate:** first-draft approval rate below 70% for two
consecutive weeks once generation is live — at which point importing a curriculum-mapped
corpus goes back on the table.

---

### Risk 2 — Teachers do not trust AI-generated questions · Impact 5 · Likelihood 3 · Score 15

One wrong answer key in a real class test ends the feature's credibility permanently,
and the teacher tells other teachers.

**Mitigation:** nothing is auto-published; the validation gate rejects before a human
ever sees it; every question shows its verdict and reasoning; approval rate is a
monitored health metric with a 70% floor; a one-tap "report this question" from the
review screen and from the student result feeds the platform bank.

---

### Risk 3 — Teachers never reach the second session · Impact 5 · Likelihood 3 · Score 15

Classic B2B education failure: signup, look around, never return. Setup cost is paid
before any value is received.

**Mitigation:** activation is a designed flow with a 12-minute target that ends in a
*real* assigned test, not a sample; three roster paths so nobody is blocked by CSV; the
first assessment is generated for them from their own chapter selection; measured as the
primary funnel metric from week 2, not after launch.

---

### Risk 4 — "Mastery" is not believed · Impact 4 · Likelihood 3 · Score 12

A teacher checks the number against a student they know well, disagrees once, and
discounts the whole product.

**Mitigation:** the refusal rule (`INSUFFICIENT` rather than a number on thin evidence)
is the single most important trust feature; every mastery figure drills to the exact
items behind it; the estimator's rules are explainable in one sentence to a teacher; the
evidence ledger makes every historical estimate reproducible.

---

### Risk 5 — Students on poor devices and poor networks · Impact 4 · Likelihood 4 · Score 16

The target student uses a shared mid-tier Android on patchy data. A lost test is an
academic harm and an unrecoverable trust event.

**Mitigation:** the offline queue and derived clock in `API_SPEC.md` §8; a 180KB bundle
budget for the player; load-tested at 200 concurrent submissions; the "zero tolerance
for lost answers" requirement with three named E2E variants (refresh, offline, timer
expiry while backgrounded).

---

### Risk 6 — Building for teachers, selling to institutes · Impact 3 · Likelihood 3 · Score 9

The user and the buyer are different people, and the institute console is a Phase 2
item.

**Mitigation:** every org is a real organization from signup, so an institute upgrade is
a plan change rather than a migration; the open question in `PRODUCT_REQUIREMENTS.md`
§10 is scheduled for decision before pricing goes public.

---

## B. Technical risks

### Risk 7 — Cross-tenant data leak · Impact 5 · Likelihood 2 · Score 10

Existential. One school seeing another's students ends the company.

**Mitigation:** three independent layers (`SECURITY_MODEL.md` §2); `force row level
security`; transaction-local tenant context; a **generated** RLS test over
`information_schema` so a new table without a policy fails CI; cross-tenant reads return
404, not 403; every attempt audited and alerted.

**Residual:** the platform-admin path is legitimately cross-tenant. Mitigated by
mandatory TOTP, full audit, and a separate 8-hour session lifetime — not eliminated.

---

### Risk 8 — The test engine loses a student's work · Impact 5 · Likelihood 2 · Score 10

**Mitigation:** IndexedDB queue; idempotent batched writes keyed on `clientSeq`; derived
clock; `client_attempt_id` idempotency; the abandoned-attempt sweep; offline/401/500 all
treated as "not now" and never as failure; three dedicated E2E variants; autosave
deliberately exempt from aggressive rate limiting.

---

### Risk 9 — Analytics slow down as data grows · Impact 3 · Likelihood 4 · Score 12

Drill-down across attempt → answer → concept is join-heavy and grows fastest.

**Mitigation:** mastery is precomputed, not queried live; class rollups become
materialised views on the documented trigger; the indexes in `DATABASE_SCHEMA.md` §13
exist from the first migration; an 800ms p95 budget is asserted rather than hoped for.

---

### Risk 10 — Postgres job queue outgrown · Impact 2 · Likelihood 3 · Score 6

**Mitigation:** documented escalation path (`DEPLOYMENT.md` §10); queue depth alerting;
the handler interface is queue-agnostic, so the swap is one adapter.

---

### Risk 11 — Migration breaks a live deploy · Impact 4 · Likelihood 2 · Score 8

**Mitigation:** forward-only; every migration must be safe against the previous
application version; expand-migrate-contract in four steps; `DIRECT_URL` for migrations
because a pooled migration fails partway with an error that names neither cause; large
backfills run as jobs.

---

## C. AI cost risks

### Risk 12 — Cost scales with students, revenue with organizations · Impact 4 · Likelihood 3 · Score 12

Per-student AI features (tutor, mistake classification) scale with the cheapest users
while pricing scales with the buyer. A large institute on a flat fee inverts the margin.

**Mitigation:** modelled at **$0.13–0.17 per student per month** (`AI_ARCHITECTURE.md`
§8), roughly 8–15% of target revenue; per-org and per-feature budgets enforced in the
gateway *before* the call; entitlements meter generous but finite AI allowances; the
Institute plan is priced per student, so cost and revenue scale together.

---

### Risk 13 — A runaway loop or retry storm · Impact 4 · Likelihood 3 · Score 12

The classic incident: a retry loop, a prompt-cache invalidation, or one enthusiastic
teacher generating 50 assessments in an evening.

**Mitigation:** per-org concurrency cap; max 2 retries with jittered backoff; hard
timeouts; **every call logged including failures and refusals**, because a retry storm
is invisible in a success-only ledger; alert at 80% of monthly budget; a per-user token
bucket per feature.

---

### Risk 14 — A silent prompt-cache invalidation triples the bill · Impact 3 · Likelihood 4 · Score 12

Nothing breaks. No error appears. The bill quietly triples.

**Mitigation:** a stable prefix order with volatile content strictly below the
breakpoint; **`usage.cache_read_input_tokens` asserted in tests** so a zero hit rate
fails CI rather than surfacing on an invoice; cost-per-generation tracked as a time
series, not only as a monthly total.

---

### Risk 15 — Mistake classification volume · Impact 3 · Likelihood 4 · Score 12

At 27% of modelled spend it is the largest single line — not because it is expensive
per call but because it runs per wrong answer.

**Mitigation:** rule-based classification at zero cost for the unambiguous cases
(unattempted, timed out, option slip); the remainder batched nightly through the Batch
API at 50%; nothing in the product requires a mistake typed within the second. Applied,
the line falls from ~$13.82 to ~$3–4 per institute per month.

---

## D. Security and privacy risks

### Risk 16 — Minors' data · Impact 5 · Likelihood 2 · Score 10

Students are 13–16. India's DPDP Act treats children's data as a distinct category, and
a school's procurement will ask.

**Mitigation:** data minimisation by default; India residency (`ap-south-1`); explicit
recorded parental consent for links; **no student PII in any prompt** — opaque ids only;
retention windows with a scheduled purge; export and deletion supported; no marketing to
student accounts.

---

### Risk 17 — A parent sees what a student should be able to keep private · Impact 4 · Likelihood 3 · Score 12

The subtle one. A child who believes a parent reads every tutor question stops asking —
which destroys both the feature and the child's willingness to admit confusion.

**Mitigation:** the parent scope is performance data only, enforced in the policy layer
and tested; tutor conversations, mistake-bank contents and free-text answers are outside
it; parents see only `RELEASED` results; the boundary is stated to parents rather than
left to be discovered.

---

### Risk 18 — Cheating undermines every downstream number · Impact 4 · Likelihood 4 · Score 16

If students cheat, mastery is measuring the wrong thing, gaps are wrong, and the North
Star metric is fiction. **This is a data-integrity risk before it is an integrity
risk.**

**Mitigation:** everything that can be server-side is (`SECURITY_MODEL.md` §3); browser
signals recorded and shown as *signals*, never as accusations; anomaly flags — an
impossible score jump, an implausible time profile — reduce an attempt's evidence weight
in the estimator rather than accusing a child; the limits are stated honestly to
customers, because a product that overclaims here will eventually be used to punish a
student it was wrong about.

---

### Risk 19 — Prompt injection through user content · Impact 3 · Likelihood 3 · Score 9

A teacher's question text and a student's free-text answer both reach a model.

**Mitigation:** user content passed as clearly delimited data, never as instruction;
structured output with schema validation, so a hijacked response fails to parse rather
than executing; the tutor cannot alter an answer key by construction — it has no write
path; output sanitised before render.

---

### Risk 20 — Key exposure · Impact 4 · Likelihood 2 · Score 8

**Mitigation:** no provider key reachable from the browser, ever; a CI grep of the build
output; secrets injected by the platform; quarterly rotation; `SESSION_SECRET` rotation
supports two active secrets so it does not sign every user out.

---

## Top five, ranked

| # | Risk | Score | The single most important action |
|---|---|---|---|
| 1 | Content cold-start | 25 | Empty bank accepted — make the empty state productive, write outcome statements rich enough to prompt from, and watch first-draft approval rate weekly |
| 2 | Cheating corrupts the data | 16 | Server-side authority; anomaly flags reduce evidence weight rather than accuse |
| 3 | Poor devices and networks | 16 | The offline queue and derived clock; three E2E failure variants |
| 4 | Teachers distrust generated questions | 15 | Human approval gate; 70% approval-rate floor as a monitored metric |
| 5 | Teachers never return | 15 | A 12-minute activation flow ending in a real assigned test |
