# Sahayak — AI Assessment & Personalised Learning Platform

**CBSE Class 9 & 10.** An assessment platform whose real product is what happens after
a student submits.

```
   ASSESS ──▶ DIAGNOSE ──▶ RECOMMEND ──▶ PRACTISE ──▶ REASSESS ──▶ MEASURE
      ▲                                                                │
      └────────────────────────────────────────────────────────────────┘
```

> **Status: all twelve MVP slices built.** Design tokens and the component library;
> authentication and multi-tenancy with a generated RLS audit; organizations,
> classes and the roster; the CBSE curriculum tree and its console; the question
> bank; the assessment builder; assignment; and the test player — student
> sign-in by phone and one-time code, a derived clock, autosave with an offline
> queue, resume after a refresh, idempotent submission, marking, the result, and
> the scheduled sweep that finishes papers nobody came back to; and results —
> the class view with item analysis, a marking board for written answers,
> release, and the student's own question-by-question review; and the
> evidence ledger with the mastery estimator — a per-concept estimate that
> carries its own uncertainty and refuses to produce a number it cannot stand
> behind; and teacher analytics — a per-concept view of what a class knows,
> with a student-by-concept grid and a per-student page that puts the scores
> beside the estimate; and the AI layer — a gateway with budgets, PII
> scrubbing and a usage ledger, and question generation that lands drafts in
> the bank behind the same validator a teacher's own typing passes; and
> learning gaps — concepts a class is below the line on, with enough evidence
> to say so, closing on evidence and on nothing else.
> Since the twelve slices: plans and entitlements, so no price is hard-coded
> anywhere; and the platform console — AI costs across every organisation, and
> audit search; AI question validation, which drops a draft with the answer in
> its stem before a teacher sees it and flags the rest with a reason; and a
> one-paragraph read of a class, on request; and the students index and
> settings, the last two MVP screens; and interventions, which close the loop —
> one click builds a remedial paper scoped to the gap's concept, calibrated to
> how far behind the group is and assigned only to them, stamping the mastery
> it started from so that "this worked" is a claim somebody can check; and the
> Mistake Bank — a student's own wrong answers, typed by rule where a rule
> suffices and by a cheap model nightly where it does not, closing only when a
> different question on the same idea comes back right; and personalised
> practice — untimed sets chosen from what the student is actually weak at,
> with the explanation the moment they answer, counting towards their
> progress at a lower weight than a supervised paper does; and the parent
> portal — a consented edge to one named child, showing performance and
> released marks and structurally unable to reach what the child wrote; and
> the institute console — exceptions before counts, batches compared with
> their denominators attached, and deliberately no league table of teachers;
> and the AI Teacher Copilot, which reasons over a teacher's own marked work
> and sends the provider opaque handles rather than any child's name.
> and subjective grading with rubrics, so a mark comes with the criteria it was
> given against; and adaptive difficulty inside practice, which follows the
> student rather than a fixed list.
> **Phase 2 is complete but for item-statistics calibration, which needs real
> response data before it can be built.**
>
> **Phase 3 began with the AI student tutor** — help on one question in three
> named rungs (a hint, then the method, then the idea said another way), which is
> given the answer key precisely so it can avoid contradicting it, and whose every
> reply is checked against that key before a student reads a word of it. A reply
> that gives it away is replaced by the teacher's own authored hint and the turn
> is stamped. A practice answer given after help counts for nothing, and the
> student is told so before they press.
>
> And the study plan — what to do next, in order: the papers with windows closing,
> then the questions they got wrong, then the concept the evidence says to work on.
> No dates and no durations, because a plan that is a timetable is wrong by Tuesday.
> Nothing is stored and nothing is ticked off; an item leaves when the evidence
> behind it moves, which is the same rule a learning gap and a mistake follow.
>
> And term reports, which close the last unbuilt promise in the teacher's
> navigation. A report leads with how much of the syllabus has actually been
> measured, carries no overall grade, refuses to exist below three measured
> ideas, and is written ONCE — regenerating supersedes rather than edits, so the
> sheet a parent was handed in September still says in December what it said
> then. It prints to a clean page, which is the download.
>
> And concept authoring in the platform console, which is the one that unblocks
> the rest. Mastery is measured per concept and questions are filed against
> outcomes; nothing could link the two outside a seed file, so the seeded
> curriculum measures five outcomes and every intelligent feature had almost
> nothing to read. Concepts can now be created, linked to the
> outcomes that measure them, and given the prerequisites that let a learning gap
> name a root cause — with cycles refused, and no delete, because nothing
> constrains evidence from pointing at a concept that no longer exists.
>
> A model drafts those groupings from the outcomes nothing measures, and a person
> accepts them one at a time. It works in indexes rather than ids so a mistyped
> identifier cannot become a link to the wrong thing, malformed proposals are
> discarded before a reviewer sees them, and an empty list is a real answer. It
> is the only AI task in the product that sends no personal data at all.
>
> **Phase 3 is now complete but for the two calibration items.** Exam readiness,
> which is deliberately a picture rather than a percentage: coverage first, then
> band counts, then the chapters nobody has tested, named — because a single
> readiness number in front of an anxious fifteen-year-old is the composite score
> this product refuses everywhere else, printed where it does the most harm.
> Institute-level analytics across cohorts, whose most useful output separates a
> concept weak in two or more classes (the material, or the order it is taught
> in) from one weak in a single room — still with no teacher league table.
> An internationalisation seam with typed catalogs and real Hindi, honest that it
> translates the interface and not the curriculum. School MIS webhooks on a
> transactional outbox, where an event is written in the same transaction as the
> thing that happened, so a delivered event is necessarily one that occurred.
> And voice input for written answers, on the browser's own speech API, absent
> rather than disabled where that API is missing.
>
> **The NCERT import (September 2026) gave it a syllabus and a bank.** 3,857
> CBSE Class 9 and 10 MCQs from the sibling NCERT project, in the Sirah Digital
> organization; draft learning outcomes and concepts for every CBSE chapter but
> Hindi — **472 outcomes grouped into 197 concepts**, with prerequisites —
> awaiting a subject teacher's review; 3,787 questions tagged to them, the 70
> that test content CBSE has removed archived, and the 23 sample-paper marking
> schemes as draft written questions. Four NCERT books that had been filed under
> the wrong subject are subjects of their own. **Every CBSE school now receives
> the 3,154 approved original questions** as its own copy; the 690 verbatim NCERT
> Exemplar problems are held back until NCERT gives permission. A subject teacher
> approves each outcome, concept and question tag at `/admin/review`, and Hindi has
> its chapters. Details in [CLAUDE.md](CLAUDE.md): "The NCERT import", "The
> question library" and "Reviewing the curriculum".
>
> **What is not built: item-statistics and item-response-theory calibration.**
> Both replace a question's declared difficulty with its observed difficulty, and
> both need roughly fifty real responses per item. The code is writable today and
> could not be shown to work — and a calibration quietly producing nonsense does
> not fail visibly, it corrupts the weighting inside the mastery estimator, which
> sits upstream of every figure this product asks a teacher to act on. They are
> waiting on usage, not on a decision.
>
> Phase 2 and Phase 3 are listed in
> [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
>
> Read [ARCHITECTURE.md](ARCHITECTURE.md) for the design and
> [CLAUDE.md](CLAUDE.md) for the working notes — the gotchas that cost time.

## Running it

```bash
cp .env.example .env       # then fill in DATABASE_URL and DIRECT_URL
npm install
npm run db:up              # Docker Postgres on port 5434
npm run db:migrate
npm run db:rls             # RLS policies; Prisma cannot express them
npm run db:seed            # CBSE, Class 9 and 10, subjects and 51 chapters
npm run dev                # http://localhost:3210
```

```bash
npm run verify             # encoding + typecheck + lint + 322 unit tests
npm run test:integration   # 281 tests, needs the database up
npm run audit:rls          # the check that must never be skipped
npm run smoke              # 912 HTTP checks against a running build
npm run test:e2e           # 178 browser checks: the thirteen flows, axe on every
                           # route, tap targets and layout at 360 / 768 / 1440
```

## The documents

| Document | What it settles |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The system: two data planes, stack, module boundaries, the submission path, the mastery estimator |
| [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) | Positioning, personas, requirements by role, business model, metrics, non-goals |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | Tokens, components, the validated chart palette, accessibility, the action rule |
| [UX_FLOW.md](UX_FLOW.md) | Every screen, navigation per role, and the seven flows that matter |
| [DOMAIN_MODEL.md](DOMAIN_MODEL.md) | The vocabulary, the aggregates, and the invariants each one holds |
| [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) | Tables, constraints, indexes, and the RLS policies |
| [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) | Provider abstraction, model tiers, the generation pipeline, privacy, the cost model |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | Auth, the three authorization layers, test integrity, data protection |
| [API_SPEC.md](API_SPEC.md) | Every route, the error contract, and the attempt path in detail |
| [TESTING.md](TESTING.md) | The pyramid, the thirteen E2E flows, the edge cases, the CI gates |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Environments, topology, migrations, monitoring, the launch gate |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Twelve vertical slices, a ten-week MVP, Phase 2 and 3 |
| [RISKS.md](RISKS.md) | Twenty scored risks with mitigations, and the top five ranked |

## The five decisions everything else follows from

1. **Two data planes.** A global, platform-owned curriculum tree; an org-owned tenant plane behind row-level security. Shared curriculum ids are what let "Geometry mastery" mean the same thing in two cities — without them the platform owns disconnected spreadsheets and no intelligence.

2. **Nothing blocks on AI.** A submitted attempt is scored and persisted synchronously; every interpretation happens on a job queue. With the provider entirely offline, students still get scores and teachers still get numbers — only the prose is missing.

3. **Mastery carries its uncertainty.** Below a minimum evidence threshold the product shows *"not enough evidence yet"* and never a number. A figure the product cannot defend is worse than a blank, because a teacher will schedule a class on it.

4. **AI proposes; a human approves.** Generated questions are drafts with validation verdicts. No AI output reaches a student unapproved, and the tutor may never contradict a stored answer key.

5. **Tenant context is transaction-local.** `set_config('app.organization_id', $1, true)` — the third argument is the entire defence against a pooled connection leaking one school's data to the next request.

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind 4 · PostgreSQL 16 + RLS · Prisma 6 ·
Anthropic Claude behind a provider interface · Postgres job queue · Cloudflare R2 ·
Vitest + Playwright

## What is built

**Slice 0 — foundation**

- A teacher signs up, gets an organization, signs in, and lands on a dashboard that is *designed* — real empty states, real navigation, nothing placeholder.
- Tenancy through Postgres row-level security, forced on every table, with the tenant set transaction-locally so a pooled connection cannot leak one school's data to the next request.
- A **generated** RLS audit that reads `information_schema`: a table added in month six without a policy fails CI on the day it is added.
- Deny-by-default authorization, unit-tested across the whole role × action matrix.
- The design system from `DESIGN_SYSTEM.md` in `globals.css`, both themes, with every contrast ratio measured rather than estimated.

**Slice 3 — curriculum**

- The CBSE tree for Class 9 and 10: **51 chapters** across Mathematics and Science, each recording where it came from.
- A platform console for authoring topics and learning outcomes, on its **own database role** — the app role has no write grant on curriculum at all, so a teacher-facing route physically cannot change what every organisation reads.
- **50 chapters deliberately have no outcomes.** An outcome statement is the only grounding a generated question will have, so inventing 400 of them would be the guess this product refuses. Class 10 Maths chapter 6 is authored as the worked example.
- A live quality check on every statement — it must lead with a verb a student performs, or a question cannot be written from it. It warns; it never blocks.

**Slices 1–2 — organizations, classes, roster**

- The head of the curriculum plane seeded and shared: CBSE, Class 9 and 10, five subjects each — readable by every tenant, writable by none of them.
- Classes with a grade, a subject and a rotatable join code whose alphabet excludes every character pair that is misread when read aloud.
- **One roster importer for both paths.** Paste a list or upload a CSV; it reads headers in any order, quoted cells, tab-separated spreadsheet paste, pasted numbering, and mixed lists where only some rows carry a roll number.
- A **dry run that cannot lie** — the preview runs the same parser and the same row checks as the commit.
- Imperfect data is imported, not rejected: a bad phone number costs the row its sign-in, not its place on the roster, and the class page says how many students cannot yet take a test.

RLS earned its place immediately: it caught two real bugs during this build — an
unscoped `user.update()` that 500'd a correct sign-in, and a slug uniqueness check that
always answered "free" and collided on the second organization. Both are recorded in
[CLAUDE.md](CLAUDE.md).

## Where to go next

Slice 1–2 in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md): organizations, classes
and the roster, ending in the activation flow that must reach a real assigned test in
under twelve minutes.

The highest risk is not technical. It was [Risk 1](RISKS.md): the question bank shipped
empty by decision, and every AI feature was grounded in content that did not exist yet.
The NCERT import has since supplied a curriculum-mapped corpus and draft outcomes for
every CBSE chapter but Hindi. What is left is human, not code: a subject teacher reviewing
the drafts, a teacher completing the 23 marking-scheme questions, and NCERT's written
permission before the Exemplar questions reach any school but Sirah Digital.
