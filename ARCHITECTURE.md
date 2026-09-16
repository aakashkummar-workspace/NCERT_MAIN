# Product Architecture

> **Status:** Proposed. Nothing here is built yet. This document is the contract the
> first line of code is written against.

## 1. What this product is

**Sahayak** (working name) is an AI assessment and personalised-learning platform for
CBSE Class 9 and Class 10.

It is **not** a mock-test app. A mock test is one event; this product is a loop:

```
   ASSESS ──▶ DIAGNOSE ──▶ RECOMMEND ──▶ PRACTISE ──▶ REASSESS ──▶ MEASURE
      ▲                                                                │
      └────────────────────────────────────────────────────────────────┘
```

The assessment layer is the cheapest part to build and the easiest to copy. The
defensible product is everything downstream of a submitted answer: the **concept
mastery estimate**, the **learning-gap detection**, and the **intervention** a teacher
actually acts on. Every architectural decision below is made to protect that loop.

### The one-sentence architecture

> A multi-tenant Next.js application over a single Postgres database with row-level
> security, where a student's answer is scored synchronously and *interpreted*
> asynchronously, and where every AI call is a typed task behind a budgeted gateway
> that is allowed to refuse.

## 2. Actors and boundaries

| Actor | Primary surface | Device bias | Trust level |
|---|---|---|---|
| Student | Test player, practice, mistake bank | Mobile-first | Lowest — adversarial during a test |
| Teacher | Assessment builder, analytics, copilot | Desktop-first | Scoped to own classes |
| Parent | Read-only progress | Mobile-first | Scoped to consented child links |
| Institute admin | Roster, KPIs, subscription | Desktop-first | Scoped to own organization |
| Platform admin | Curriculum, global bank, tenants | Desktop | Cross-tenant, audited |
| Scheduler | Cron endpoints | — | No person; bearer token only |

**Nobody's organization or role is ever read from a request body.** Both are derived
from the session on every request. This is the single rule most likely to be violated
under deadline pressure, and it is the one that leaks another school's students.

## 3. The two data planes

The most important schema decision. Data splits into two planes with different owners,
lifecycles and access rules.

### Plane 1 — Curriculum (global, platform-owned, read-only to tenants)

```
board → grade → subject → chapter → topic → learning_outcome → concept
```

Seeded and versioned by the platform. Shared by every tenant. A tenant never writes
here. This is what makes cross-tenant intelligence possible: "Geometry mastery" means
the same thing in Chennai and in Coimbatore because both point at the same
`concept.id`. If each tenant defined its own chapters, the platform would own a pile
of disconnected spreadsheets and no intelligence at all.

### Plane 2 — Tenant (org-owned, RLS-enforced)

```
organization → members → classes → students → assessments → attempts → mastery
```

Every row carries `organization_id`. Every query runs inside a transaction that has
set the tenant context. No exceptions.

### The seam: questions belong to both planes

A question is the one entity that spans the planes:

| `visibility` | Owner | Who can read it |
|---|---|---|
| `GLOBAL` | Platform | Every tenant |
| `ORGANIZATION` | An org | That org only |
| `PRIVATE` | A teacher | That teacher only |

`organization_id` is `NULL` exactly when `visibility = GLOBAL`, enforced by a CHECK
constraint rather than by convention. The RLS policy reads
`organization_id IS NULL OR organization_id = current_org()`.

## 4. Stack

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| Framework | Next.js 16, App Router, React 19 | Server Components keep heavy analytics queries on the server; one deployable covers marketing site, teacher app and student app. |
| Language | TypeScript, `strict` | Non-negotiable at this schema size. |
| Styling | Tailwind CSS v4, CSS-first `@theme` | Tokens live in CSS custom properties, so the design system is one file rather than a config object nobody reads. |
| Database | PostgreSQL 16 | RLS is the tenancy mechanism. No other database in this class gives it to us for free. |
| ORM | Prisma 6 | Typed client and migrations. RLS policies live in hand-written migration SQL, because Prisma cannot express them. |
| Auth | In-house, session cookie | Students are the bulk of MAU; per-MAU vendor pricing is structurally wrong for this business. Detail in `SECURITY_MODEL.md`. |
| Jobs | Postgres queue, `FOR UPDATE SKIP LOCKED` | At MVP volume, adding Redis buys a second thing to operate and nothing else. Revisit above roughly 50 jobs/second. |
| AI | Anthropic Claude via `@anthropic-ai/sdk` | Behind a provider interface — see `AI_ARCHITECTURE.md`. |
| Files | S3-compatible (Cloudflare R2) | Egress cost matters when serving question images to a whole school. |
| Charts | Hand-built SVG/HTML on the validated palette | A charting library imports its own colour opinions; the palette in `DESIGN_SYSTEM.md` is computationally validated and must survive contact with the product. |
| Tests | Vitest, Playwright | See `TESTING.md`. |

## 5. Module boundaries

```
src/
  app/                    Next routes. Thin. No business logic.
    (marketing)/          Public site
    (auth)/               Sign-in, invitations
    (teacher)/            Teacher workspace
    (student)/            Student app
    (parent)/             Parent view
    (institute)/          Admin console
    (platform)/           Platform admin
    api/                  Route handlers
  core/                   Business logic. Pure where possible. No React, no Next.
    curriculum/           Curriculum tree access
    assessment/           Blueprint, assembly, publish
    attempt/              Test engine, scoring
    mastery/              The estimator — the product's core IP
    gaps/                 Gap detection and prioritisation
    recommend/            Practice and intervention generation
    identity/             Sessions, roles, membership
    billing/              Plans and entitlements
  ai/                     Provider, router, gateway, tasks
  db/                     Prisma client, tenant transaction helper
  jobs/                   Queue, workers, handlers
  ui/                     Design system components. No business logic.
```

**The rule the folder layout exists to enforce:** `core/` never imports from `app/`,
and `ui/` never imports from `core/`. A component receives data; it does not fetch it.
Enforced by an ESLint `no-restricted-imports` rule, because a convention that is not
enforced is a convention that is already broken.

## 6. The request lifecycle

Every authenticated request:

```
  Request
     │
     ├─▶ Session cookie → session record → { userId, orgId, role, memberId }
     │
     ├─▶ Route handler validates input with a Zod schema (reject, never coerce)
     │
     ├─▶ withTenant(orgId, async tx => { ... })
     │      └─ BEGIN
     │         SELECT set_config('app.organization_id', $1, true)   ← transaction-local
     │         ...queries, all RLS-filtered...
     │         COMMIT
     │
     └─▶ Typed response
```

`set_config(..., true)` — the third argument is `is_local`. With a transaction-mode
connection pooler in front of Postgres, a session-level `SET` leaks into the next
request that borrows that connection, which is a cross-tenant read. The `true` is the
entire defence and it is not optional.

## 7. The submission path — the one flow that must never block

A student pressing Submit is the highest-stakes moment in the product. It happens at
thirty students in one second in a computer lab, on poor wifi, on inexpensive Android
phones.

**Synchronous, and nothing else:**

```
  POST /api/attempts/{id}/submit
     │
     ├─ 1. Is this attempt open, and does it belong to this student?
     ├─ 2. Idempotency: has clientAttemptId already been submitted? → return the prior result
     ├─ 3. Is the server clock past startedAt + durationMs? → accept, mark late/auto
     ├─ 4. Score objective items against the stored key (server-side, always)
     ├─ 5. Persist attempt + answers + raw score in one transaction
     ├─ 6. Write an outbox row: attempt.submitted
     └─ 7. Respond with the score
```

**Asynchronous, driven by the outbox:**

```
  attempt.submitted
     ├─▶ mastery.update        Update the estimate for each concept touched
     ├─▶ gaps.detect           Recompute class-level and student-level gaps
     ├─▶ mistakes.record       Add wrong answers to the mistake bank
     ├─▶ recommend.generate    Deterministic candidate set, then AI ordering
     └─▶ ai.narrate            The prose a teacher reads. Optional by definition.
```

If the AI provider is down, a student still gets their score, a teacher still gets
their numbers, and only the sentence explaining them is missing. That is the correct
failure mode, and it is a structural property rather than a `try/catch`.

## 8. The mastery estimator

This is the product. Everything else is plumbing around it.

**What it is not:** `correct / attempted`. A percentage over three questions is noise
presented as a fact, and a teacher who acts on it once and is wrong stops trusting the
product permanently.

**What it is:** a per-`(student, concept)` estimate that carries its own uncertainty.

```
  mastery = { p: 0.54, confidence: 0.31, evidenceCount: 4, lastEvidenceAt: … }
```

Each answered question is one piece of evidence, weighted by:

- **Difficulty** — a correct answer on a hard item moves the estimate more than a correct answer on an easy one.
- **Recency** — an exponential decay, so December's mastery is not July's.
- **Discrimination** — an item everyone gets right, or everyone gets wrong, tells us little. Item statistics are calibrated from real attempts, from Phase 2 onward.

**The refusal rule.** Below a minimum evidence threshold the UI shows
*"Not enough evidence yet"* and never a number. A mastery figure the product cannot
stand behind is worse than a blank, because a teacher will schedule a remedial class
on it. This is enforced in `core/mastery`, not in the components — a number that
should not exist must not reach a component that might render it.

## 9. Deployment topology

```
  ┌────────────┐    ┌──────────────────┐    ┌─────────────────┐
  │  Browser   │───▶│  Next.js         │───▶│  Postgres       │
  │ (PWA-ready)│    │  (Vercel)        │    │  (Neon, pooled) │
  └────────────┘    └────────┬─────────┘    └────────▲────────┘
                             │                       │
                             ▼                       │
                    ┌──────────────┐        ┌────────┴────────┐
                    │  R2 (files)  │        │  Worker         │
                    └──────────────┘        │  (Fly/Railway)  │
                                            │  queue + cron   │
                                            └────────┬────────┘
                                                     ▼
                                            ┌─────────────────┐
                                            │  Anthropic API  │
                                            └─────────────────┘
```

The worker is a separate long-lived process rather than a serverless function, because
AI question generation takes 30–120 seconds and a serverless timeout is the wrong
constraint to design a product around. Details in `DEPLOYMENT.md`.

## 10. Decisions deliberately deferred

Recorded so that they are not accidentally decided by a hurried commit:

| Deferred | Until | Default if forced to choose now |
|---|---|---|
| Redis or a dedicated queue | Job latency becomes a complaint | Stay on Postgres |
| Item Response Theory calibration | Roughly 50k graded responses exist | Difficulty stays teacher-declared |
| Handwritten answer capture (photo → grade) | The objective loop is proven | Out of scope; subjective items are teacher-graded |
| Regional-language UI | First non-English-medium customer | English only |
| Native mobile app | PWA install rate has been measured | PWA |
| Cross-tenant benchmarking | Legal review of consent | Off |
