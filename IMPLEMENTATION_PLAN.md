# Implementation Plan

## 1. Method

**Vertical slices.** Each slice goes from schema to UI and is genuinely usable before
the next begins. No slice is "done" with a placeholder screen — the design system
applies from the first pixel, because retrofitting a design system is a rewrite wearing
a smaller word.

**Order:**

```
  0  Foundation        tokens, shell, auth, tenancy, RLS
  1  Organization      signup → org → membership
  2  Class & roster    classes, students, invitations
  3  Curriculum        the CBSE tree, seeded
  4  Question          manual authoring + bank
  5  Assessment        blueprint → build → publish
  6  Assignment        assign, windows, settings
  7  Attempt           the test engine        ← the highest-risk slice
  8  Result            scoring, review, release
  9  Mastery           the estimator + evidence ledger
 10  Analytics         teacher dashboards
 11  AI generation     the pipeline + review queue
 12  Gaps              detection → intervention → measurement
```

Slices 0–8 are a working assessment product. **9–12 are the actual product**, and the
order is deliberate: the intelligence is built on real submitted data, not on fixtures.

## 2. MVP scope

Ten weeks, two engineers. Slices 0–11 plus a thin slice of 12.

### In

**Teacher:** signup, org, classes, students (paste / CSV / join code), manual questions,
question bank with filters, AI generation with a review queue, six-step assessment
builder, publish, assign, results, release, chapter/concept mastery.

**Student:** OTP or class-code sign-in, assigned tests, the test player (timer,
navigation, mark for review, autosave, offline-tolerant), submit, result, answer review
after release, progress.

**Platform:** curriculum management, global bank curation, tenants, AI cost dashboard,
audit search.

**AI:** question generation, validation, one class-insight narrative.

### Out of MVP, deliberately

Parent portal, institute console, Copilot, mistake bank, personalised practice,
subjective grading, live monitoring, study plans, tutor.

**Why parent is out despite being a strong selling point:** a parent dashboard with no
mastery history behind it shows a score and a blank chart, which is worse than nothing
for the parent's trust. It needs slice 9 to have been running on real data for a few
weeks. It is first in Phase 2, not last.

## 3. Schedule

| Week | Slices | Ships |
|---|---|---|
| 1 | 0 | Tokens, component library, app shell, auth, tenancy + RLS with the generated audit test |
| 2 | 1, 2 | Signup → org → class → students. Onboarding flow. |
| 3 | 3, 4 | Curriculum seeded; manual question authoring; the bank |
| 4 | 5 | Assessment builder, all six steps, blueprint validation |
| 5 | 6, 7a | Assignment; test player shell; server-authoritative clock |
| 6 | 7b | Autosave, offline queue, resume, submit idempotency, the sweep |
| 7 | 8 | Scoring, results, item analysis, release, student review |
| 8 | 9 | Evidence ledger, mastery estimator, the refusal rule |
| 9 | 10, 11a | Teacher analytics; the AI gateway, router, budgets, usage ledger |
| 10 | 11b, 12a | Generation pipeline, validation, review queue; gap detection |

**Week 6 is the schedule's real risk.** The offline-tolerant test engine is the hardest
week and the one that cannot be shipped at 80%. If a week is going to slip, plan for it
to be this one.

## 4. Slice 0 — the first thing built

Everything else stands on it, so it is specified fully.

**Deliverables**

1. Next.js 16, TypeScript strict, Tailwind 4. Tokens from `DESIGN_SYSTEM.md` §2–5 in `globals.css`, both themes.
2. `src/ui/`: Button, Input, Select, Card, StatCard, Badge, Modal, Drawer, Tooltip, Toast, EmptyState, Skeleton, DataTable, AppShell, Sidebar, PageHeader, BottomTabs. Every state, both themes, keyboard-operable.
3. Prisma schema for `organizations`, `users`, `memberships`, `sessions`, `invitations`, `audit_logs`.
4. RLS migration: policies enabled **and forced**; `withTenant()`; `set_config(..., true)`.
5. Auth: signup, sign-in, sign-out, session cookie, argon2id, OTP scaffold.
6. `core/identity/authorize.ts` with the deny-by-default predicate.
7. CI: lint, typecheck, unit, integration on Docker Postgres, the generated RLS audit, bundle size, axe.

**Definition of done**

- A teacher signs up, gets an organization, signs in, sees an empty dashboard that is *designed* — real empty states, real navigation, nothing placeholder.
- The generated cross-tenant test passes for every table that exists.
- A new table without RLS **fails CI**.
- Every component renders in light and dark and is fully keyboard-operable.
- No component imports from `core/`; no `core/` module imports from `app/`.

**Not in slice 0:** any feature. This week buys the ability to build the next nine
quickly and the tenancy guarantee that cannot be added later.

## 5. Phase 2 — weeks 11–20

Order chosen by *evidence produced per week*: mastery data is already accruing, so the
features that read it come first.

| Slice | Weeks | Why here |
|---|---|---|
| Learning Gaps + interventions (complete 12) | 11–12 | Mastery data now exists; this is the North Star loop |
| Mistake Bank | 13 | Direct student value from data already stored |
| Personalised practice | 14–15 | Closes the loop for the student |
| Parent portal | 16–17 | Now has real history behind it |
| Institute console | 18–19 | Unblocks the larger contract |
| AI Teacher Copilot | 20 | Highest cost per call — last, once the data it reasons over is trustworthy |

Also in Phase 2: subjective grading with rubrics, adaptive difficulty inside practice,
and the first item-statistics calibration (replacing declared difficulty with observed
`p_value` once roughly 50 responses per item exist).

## 6. Phase 3 — weeks 21+

**The AI student tutor with progressive hints is BUILT.** Three named rungs — a
hint, then the method, then the idea said another way — entered from a mistake or
from a practice question, never stating the answer, and checked against the stored
key rather than trusted to obey the prompt. A helped practice answer produces no
evidence, and the student is told so before they press.

**The study plan is BUILT.** What to do next, in order: papers whose windows are
closing, then a named concept to revise before a scheduled test, then the
questions they got wrong, then what the evidence says to practise. Derived at
read time, stored nowhere, with no dates and no checkboxes.

**Term reports are BUILT** — stamped rather than derived, superseded rather than
edited, no overall grade, coverage above the marks, and a print stylesheet that
is the download feature.

**Concept authoring is BUILT**, and it was the binding constraint rather than a
missing screen: mastery is measured per concept, questions are filed against
outcomes, and until this existed nothing could link the two outside a seed file.

**Exam readiness is BUILT** — coverage, band counts and the untested chapters by
name. Deliberately no readiness percentage; see `CLAUDE.md`.

**Institute-level advanced analytics is BUILT** — cohort comparison, a
systemic-versus-localised verdict per concept across batches, and improvement
claimed only against a stamped baseline. Still no teacher league table.

**Internationalisation is BUILT as a seam** — locale resolution, typed catalogs,
`Intl` plurals and formatting, proven on one surface. It translates the
interface, not the curriculum: a Hindi question bank is an authoring project.

**School MIS webhooks are BUILT** on a transactional outbox with a job runner —
events written in the same transaction as the thing that happened, HMAC-signed
with the timestamp inside the signed string, DEAD rather than disappeared.

**Voice input is BUILT** on the browser's own Web Speech API — no provider
account, no audio to any Sahayak server, and absent rather than disabled where
the API is missing.

**Multi-board support is structurally present already.** `Board` carries `code`,
`name`, `country` and `grades`, and nothing in the code assumes CBSE. What is
missing is another board's curriculum content, which is authoring rather than
engineering — the same constraint concept authoring just removed.

### The two that cannot be built yet, and it is not effort

**Item-statistics calibration** and **item-response-theory calibration** both
replace a question's declared difficulty with its observed difficulty. Both need
roughly fifty real responses per item before the estimate means anything; this
database has a handful. The code is writable today and could not be shown to
work — and a calibration that silently produces nonsense does not fail visibly,
it corrupts the difficulty weighting inside the mastery estimator, which is
upstream of every figure this product asks a teacher to act on. They are waiting
on real usage, not on a decision.

What IS built is the half that cannot corrupt anything: `core/itemstats` derives
classical item statistics for one question on read, shows them to a teacher, and
writes nothing — declared difficulty stays what the estimator reads.

### Content: the NCERT import (September 2026)

The binding constraint named above — curriculum content — is now met for CBSE
Class 9 and 10, as drafts. From the sibling NCERT project: 3,857 MCQs in the
Sirah Digital organization; 472 learning outcomes grouped into 197 concepts with
prerequisites, covering every chapter but Hindi; 3,787 questions tagged to
them; 70 out-of-syllabus questions archived; 23 CBSE sample-paper marking
schemes as draft written questions. The scripts and the reasoning are in
CLAUDE.md, "The NCERT import".

Since then: the **question library** copies the 3,154 approved original
questions into every CBSE school (Exemplar held back behind a switch until NCERT
permits it); **`/admin/review`** lets a subject teacher approve each outcome,
concept and question tag; **Hindi** has its chapters (Class 9 Ganga; Class 10
Hindi A and Hindi B); and **SMS** has a setup checklist and a test-send script.

Four things remain, and none of them is engineering:

1. **A subject teacher reviews the drafts** at `/admin/review` — the outcomes, the
   concept groupings and the tags — before any school is told its mastery
   figures mean something. Hindi outcomes need a Hindi teacher to write them.
2. **A teacher completes the 23 marking-scheme questions** from the sample
   papers; their stems are abbreviated and no student could answer one as is.
3. **NCERT's written permission** before the bank reaches any school but Sirah
   Digital. 690 questions are verbatim Exemplar problems and Sahayak is
   commercial. Until then, only the 3,167 original questions may be shared.
4. **An MSG91 account and DLT registration** (docs/SMS_SETUP.md), without which
   no student on a live deployment can sign in.

Everything else on the Phase 3 menu is now built. It remains a menu rather than a
queue: anything further requires a customer asking for it.

## 7. Team and parallelisation

Two engineers, split by seam rather than by layer:

- **A** — data, tenancy, assessment, attempt, scoring, mastery, jobs.
- **B** — design system, teacher UI, student UI, analytics rendering.

They meet at the API contract in `API_SPEC.md`, which is written before either starts a
slice. Splitting front-end from back-end across the same feature is what produces two
half-features and an integration week.

Weeks 9–11, B takes the AI pipeline while A hardens the attempt path under load.

## 8. Definition of done — every slice

- [ ] Schema migrated; RLS policy present and forced; the audit test covers it
- [ ] `core/` logic unit-tested, including the failure paths
- [ ] Routes validated with Zod; policy predicate tested for every role
- [ ] UI uses only design-system components and tokens
- [ ] Empty, loading and error states written per module — not generic
- [ ] Responsive at 360 / 768 / 1440; tap targets ≥ 44px
- [ ] Keyboard-operable; axe clean
- [ ] E2E for the happy path plus the two most likely failures
- [ ] Audit log entries for the state changes that matter
- [ ] Performance budget met

## 9. What could make this schedule wrong

| Assumption | If false |
|---|---|
| Two engineers, uninterrupted | Linear slip; the order still holds |
| Curriculum data can be seeded in one week | Slice 3 is the critical path — see Risk 1 |
| The offline test engine takes one week | Most likely single-week overrun; budget two |
| Generation reaches 70% approval within two weeks of prompt work | Slice 11 slips; the MVP still ships without generation, which is why it is late in the order |
| Postgres is enough for jobs at MVP scale | Adds a Redis week in Phase 2 |

The slice order is deliberately arranged so that **the MVP is still shippable if AI
generation fails entirely**. Slices 0–10 are a complete, sellable assessment and
analytics product. Generation is an accelerant, not a foundation — and a plan where the
riskiest dependency is also load-bearing is not a plan.
