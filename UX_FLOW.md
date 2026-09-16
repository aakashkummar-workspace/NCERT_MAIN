# UX Information Architecture and Flows

Phase markers: **[M]** MVP · **[2]** Phase 2 · **[3]** Phase 3.

## 1. Complete screen map

### 1.1 Public and authentication

```
/                          Marketing home                              [M]
/pricing                   Plans                                        [M]
/for-teachers              Teacher value proposition                    [M]
/for-institutes            Institute value proposition                  [2]
/signin                    Email + password (teacher/admin)             [M]
                           Phone + OTP (student/parent)                 [M]
/signup                    Teacher self-serve → creates an organization [M]
/invite/[token]            Accept an invitation, set credentials        [M]
/forgot-password           Reset request → email link                   [M]
/onboarding                4 steps: org → class → students → first test [M]
```

### 1.2 Teacher

```
/teacher                         Dashboard                                    [M]
/teacher/classes                 All classes                                  [M]
/teacher/classes/[id]            Roster, performance, assessments             [M]
/teacher/classes/[id]/students/[sid]   Student detail: mastery, attempts, gaps [M]

/teacher/assessments             All assessments (draft / scheduled / live / closed) [M]
/teacher/assessments/new         Builder — 6 steps                            [M]
/teacher/assessments/[id]        Overview: blueprint, questions, assignments  [M]
/teacher/assessments/[id]/edit   Builder in edit mode                         [M]
/teacher/assessments/[id]/assign Assign to class / students / window          [M]
/teacher/assessments/[id]/live   Live monitor: who started, submitted, flagged [2]
/teacher/assessments/[id]/results  Results: distribution, per-question, per-student [M]
/teacher/assessments/[id]/results/[attemptId]  One attempt, answer by answer  [M]
/teacher/assessments/[id]/grade  Subjective grading queue                     [2]

/teacher/questions               Question bank: global + org + private        [M]
/teacher/questions/new           Manual question editor                       [M]
/teacher/questions/[id]          Edit, version history, usage stats           [M]
/teacher/questions/generate      ✦ AI generation workspace                    [M]
/teacher/questions/review        Review queue for AI drafts                   [M]

/teacher/students                All students across classes                  [M]
/teacher/analytics               Class → subject → chapter → topic drill-down [M]
/teacher/analytics/gaps          Learning Gaps, prioritised                   [2]
/teacher/copilot                 ✦ AI Teacher Copilot                         [2]
/teacher/reports                 Report builder and archive                   [2]
/teacher/settings                Profile, notifications, preferences          [M]
```

### 1.3 Student

```
/student                         Home — today's focus                         [M]
/student/tests                   Assigned: upcoming / open / completed        [M]
/student/tests/[id]              Pre-test brief: rules, duration, marks       [M]
/student/attempt/[attemptId]     The test player (distraction-free shell)     [M]
/student/results/[attemptId]     Result: score, strengths, gaps, next step    [M]
/student/results/[attemptId]/review   Answer-by-answer review with explanations [M]
/student/practice                Recommended practice sets                    [2]
/student/practice/[sessionId]    Practice runner                              [2]
/student/progress                Mastery over time, by subject and chapter    [M]
/student/mistakes                Mistake Bank                                 [2]
/student/mistakes/[id]           One mistake: why it was wrong, retry         [2]
/student/plan                    Study plan                                   [3]
/student/tutor                   ✦ AI tutor (always entered from a question)  [3]
/student/profile                 Profile and settings                         [M]
```

### 1.4 Parent

```
/parent                         Overview — one child, or a child switcher    [2]
/parent/performance             Subject-level performance in plain language  [2]
/parent/tests                   Tests taken and scores                       [2]
/parent/progress                Improvement over time                        [2]
/parent/recommendations         What to do this week                         [2]
/parent/reports                 Downloadable term reports                    [2]
/parent/link/[token]            Accept a parent link invitation              [2]
```

### 1.5 Institute admin

```
/institute                         Dashboard: KPIs and exceptions               [2]
/institute/teachers                Teachers, invitations, class load            [2]
/institute/students                Students, bulk import, transfers             [2]
/institute/classes                 Classes and batches                          [2]
/institute/assessments             All assessments across the institute         [2]
/institute/analytics               Batch comparison, subject performance        [2]
/institute/analytics/teachers      Teacher activity and outcomes                [2]
/institute/reports                 Institute reports                            [2]
/institute/subscription            Plan, usage, invoices                        [2]
/institute/settings                Org profile, roles, academic year            [2]
```

### 1.6 Platform admin

```
/admin/organizations           Tenants, plan, usage                         [M]
/admin/curriculum              Board → subject → chapter → outcome editor   [M]
/admin/questions               Global bank curation                         [M]
/admin/ai                      Model routing, prompt versions, cost         [M]
/admin/audit                   Audit log search                             [M]
```

### 1.7 System

```
/offline                   Offline fallback                             [2]
/403 /404 /500             Error pages with a route back                [M]
```

## 2. Navigation

**Teacher** (sidebar, 240px, collapsible to icons):
Dashboard · My Classes · Assessments (All, Create, Assigned, Results) · Question Bank ·
Students · Analytics · ✦ AI Copilot · Reports · Settings

**Student** (bottom tabs on mobile, sidebar ≥ lg — five tabs maximum):
Home · My Tests · Practice · Progress · Profile
*Mistake Bank and Study Plan are reached from Home and from a result, not from a tab.
Five tabs is the limit; a sixth makes all six harder to hit.*

**Parent** (bottom tabs, four): Overview · Performance · Progress · Reports

**Institute** (sidebar): Dashboard · Teachers · Students · Classes · Assessments ·
Analytics · Reports · Subscription · Settings

## 3. Flows

### 3.1 Teacher signup to first assigned test — the activation path

This is the flow the business depends on. Target: **under 12 minutes**, and the teacher
should reach a real, useful artefact before being asked to invest anything.

```
  /signup  ─ email, password, name
     ↓
  Create organization ─ name, board (CBSE), classes taught
     ↓  An org is created even for a solo teacher. There is no
        "personal" mode; the solo teacher is an org of one, so
        upgrading to an institute later changes a plan, not a schema.
     ↓
  Create first class ─ "Class 10-A", subject, academic year
     ↓
  Add students ─ three routes, all present from day one:
        · Paste a list of names (fastest; generates join codes)
        · CSV upload with column mapping and a dry-run preview
        · Share a class join code (students self-enrol, teacher approves)
     ↓
  ✦ Create first assessment  ← the activation moment
     ↓
  Assign → share link / codes
     ↓
  Dashboard now has a real state, not an empty shell
```

**Deliberate choice:** the teacher builds a real assessment during onboarding, not a
sample. A demo the user did not make teaches nothing about their own class.

### 3.2 Assessment builder — six steps

```
  Step 1  Basics        Class, subject, name, duration, total marks
  Step 2  Curriculum    Chapters → topics → learning outcomes (multi-select tree)
  Step 3  Blueprint     Question count, marks, difficulty mix, type mix
                        Live validation: "40 questions × marks ≠ 80" is caught here,
                        not after generation.
  Step 4  Source        ✦ Generate with AI  |  Pick from bank  |  Write manually
                        These compose — 20 from the bank, 20 generated, is normal.
  Step 5  Review        Every question, with its outcome, difficulty, marks and
                        AI validation verdict. Edit / regenerate / replace / reorder /
                        delete. Nothing is published unread.
  Step 6  Publish       Assign to classes or students, set an open/close window,
                        choose settings (shuffle, review-after, attempts allowed).
```

Rules: every step is a saved draft; leaving never loses work. Steps 1–3 are revisitable
without discarding step 4's questions unless the blueprint changed incompatibly — and
then the user is told exactly what will be dropped, and confirms.

### 3.3 AI generation, in detail

```
  Teacher sets blueprint
     ↓
  POST /api/ai/assessments/generate  → returns a job id immediately
     ↓
  Worker:
     1. Resolve the curriculum scope to learning_outcome ids
     2. Retrieve existing bank questions for those outcomes (avoid duplication)
     3. Generate in batches of ~6, one call per batch, per outcome group
     4. Validate every item (schema, single answer, distractor quality,
        syllabus scope, duplicate check by embedding similarity)
     5. Items that fail validation are regenerated once, then dropped
     6. Persist as DRAFT with a per-item validation report
     ↓
  UI polls / streams the stage checklist (real stages, real counts)
     ↓
  Teacher lands in Step 5 Review with drafts and verdicts
     ↓
  Teacher approves → status APPROVED → only now usable in a published assessment
```

**If generation returns 9 of 12:** the teacher gets 9 drafts, an honest message, and
two buttons — retry the remainder, or fill from the bank. A partial result is never
silently padded with weaker questions.

### 3.4 Student attempt

```
  /student/tests → open test → pre-test brief (duration, marks, rules, attempts left)
     ↓ [ Start ]
  POST /api/attempts  → server creates the attempt, stamps startedAt, returns
                        questions WITHOUT answer keys
     ↓
  Test player
     · Timer derived as startedAt + durationMs - serverNow, never accumulated.
       A backgrounded tab for three hours must not gain or lose time.
     · Autosave every answer change, debounced 800ms, plus on navigation,
       plus on visibilitychange.
     · Offline-tolerant: answers queue in IndexedDB and sync opportunistically.
       Offline, 401 and 500 all mean "not now" — a student mid-exam is never
       blocked and never loses work.
     · Mark for review, navigator grid, previous/next.
     ↓
  Submit (or auto-submit at expiry, or server-side sweep if the tab died)
     ↓
  Server scores objective items, persists, responds
     ↓
  /student/results/[attemptId]
```

### 3.5 Result page

Order is deliberate — the score is the smallest part:

```
  1. Score + percentage + delta against the student's own previous attempt
  2. What you did well          (2–3 outcomes at or above mastery)
  3. Where you struggled        (2–3 outcomes below, with the evidence count)
  4. Your biggest gap           One concept, one number, one button
  5. [ Start 10 targeted questions ]   ← the loop closes here
  6. Review answers             Per question: your answer, correct answer,
                                explanation, and "why this was wrong"
```

Comparison is always against **the student's own past**, never a class rank. Rank is
available to the teacher; it is not shown to the student by default, and never to the
parent.

### 3.6 The gap-to-improvement loop — the product's reason to exist

```
  Attempts submitted
     ↓
  mastery.update per (student, concept)
     ↓
  gaps.detect  ─ class level: concepts where ≥ N students are below threshold
                 student level: concepts below threshold with enough evidence
     ↓
  Teacher sees:  "15 students below mastery in Similarity of Triangles"
                 [ View students ]  [ ✦ Create remedial test ]
     ↓
  One click builds a remedial assessment scoped to that outcome, at
  difficulty calibrated to the affected group, assigned only to them
     ↓
  Students practise / retest
     ↓
  mastery.update again
     ↓
  Improvement is measured against the recorded baseline and shown as
  the outcome of the intervention — the North Star metric
```

The baseline is stamped when the intervention is created. Without that stamp,
"improvement" is unfalsifiable, and an unfalsifiable improvement claim is the thing
that eventually loses the customer.

### 3.7 Parent linking (consent, not assumption)

```
  Teacher or institute invites a parent for a specific student
     ↓
  Parent receives a link → /parent/link/[token] → verifies phone by OTP
     ↓
  A ParentLink row is created: (parent_user, student, consent, scope)
     ↓
  Parent sees performance, trends, recommendations
  Parent never sees: the student's questions to the tutor, their mistake
  bank contents, free-text answers, or any other child
```

A parent's access is an explicit consented edge, not a property of being a parent.

## 4. Cross-cutting UX rules

1. **Every list has an empty state that creates something.** Written per module.
2. **Every destructive action is confirmed and names the blast radius** ("This removes the assessment for 38 students who have not yet started").
3. **Every AI output is labelled and editable.** Nothing AI-generated reaches a student without a human approval step.
4. **Every error names what survived.**
5. **Every number that drives a decision is clickable** — it drills to the rows behind it. A metric nobody can audit is a metric nobody trusts twice.
6. **The student never waits on AI.** Scores are synchronous; explanations arrive when they arrive.
