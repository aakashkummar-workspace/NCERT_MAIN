# Domain Model

The vocabulary. Where a word is defined here, it means this everywhere — in code, in
the database, in the UI and in a conversation with a customer.

## 1. Ubiquitous language

| Term | Definition | Not to be confused with |
|---|---|---|
| **Organization** | The tenant. Owns users, classes, students and data. A solo teacher is an org of one. | School — a school may run several orgs, and an org may be one tuition centre |
| **Member** | A user's role *inside* one organization. A user may be a member of several. | User — identity is global, membership is per-org |
| **Class** | A teaching group: grade + section + subject + academic year. | Grade — Class 10 the grade vs "Class 10-A Mathematics" the group |
| **Learning outcome** | The smallest curricular claim a question can test. "Applies the criteria for similarity of triangles." | Topic — a topic contains several outcomes |
| **Concept** | The unit mastery is measured against. Usually 1:1 with an outcome; occasionally shared across subjects. | Chapter — far too coarse to act on |
| **Question** | A reusable item. Immutable once approved; edits create a new version. | Assessment question — the placement of a question in one assessment |
| **Assessment** | A blueprint plus an ordered set of questions. A definition, not an event. | Assignment — the event of giving it to people |
| **Assignment** | An assessment given to a class or set of students, in a window, with settings. | Attempt |
| **Attempt** | One student's single sitting of one assignment. | Submission |
| **Mastery** | An estimate, with uncertainty, of a student's command of a concept. | Score — a score is one event, mastery is a belief across events |
| **Gap** | A concept where mastery is below threshold *with sufficient evidence*. | Low score |
| **Intervention** | A deliberate action taken against a gap, with a stamped baseline. | Remedial test — one possible form of intervention |

**"Mastery" and "score" must never be used interchangeably**, in code or in the UI. A
score is what happened. Mastery is what we believe. Conflating them is how a product
starts making claims it cannot defend.

## 2. Aggregates and their invariants

### Organization
- Owns every tenant-plane row through `organization_id`.
- Deleting an org is a soft delete plus a scheduled purge; attempts and audit logs survive the retention window.

### User and Membership
- A `User` is a global identity (email or phone). A `Membership` binds it to one org with one role.
- **Invariant:** every request resolves to exactly one active membership. A user with two memberships picks an org at sign-in; the session stores the choice.
- **Invariant:** role and `organization_id` come from the session's membership, never from a request payload.

### Class
- **Invariant:** a student's enrolment in a class is time-bounded (`joined_at`, `left_at`). A student who transfers mid-year keeps their history and stops appearing in the new class's past results.

### Question
- Lifecycle: `DRAFT → IN_REVIEW → APPROVED → (ARCHIVED)`, plus `REJECTED` from review.
- **Invariant:** only `APPROVED` questions may enter a published assessment.
- **Invariant:** an approved question is immutable. An edit creates `question_version n+1`; the old version stays because attempts reference the version they were served.
- **Invariant:** an AI-generated question is created as `DRAFT` and can only become `APPROVED` through a human action recorded with a user id.
- **Invariant:** exactly one correct option for `MCQ`; at least one for `MULTI_SELECT`; `NULL` answer key for subjective types.

### Assessment
- Lifecycle: `DRAFT → PUBLISHED → CLOSED → (ARCHIVED)`.
- **Invariant:** publishing snapshots the question set into `assessment_questions` with the version id. Later edits to the source question never change a published paper.
- **Invariant:** an assessment with at least one attempt cannot change its questions or marks. It can be closed, or copied into a new draft.
- **Invariant:** `sum(assessment_questions.marks) = assessments.total_marks`, checked at publish.

### Attempt
- Lifecycle: `IN_PROGRESS → SUBMITTED → SCORED → (RELEASED)`.
- **Invariant:** `client_attempt_id` is unique per `(assignment, student)` and is the idempotency key. A retried submit updates, never forks.
- **Invariant:** the answer key is never sent to the client during `IN_PROGRESS`.
- **Invariant:** scoring is server-side and re-derivable from `attempt_answers` plus the frozen question versions. A score that cannot be recomputed cannot be defended when a parent disputes it.
- **Invariant:** the clock is derived (`started_at + duration_ms`), never accumulated client-side.
- **Invariant:** `RELEASED` is separate from `SCORED` — a teacher controls when students see results.

### Mastery
- One row per `(student, concept)`.
- **Invariant:** carries `evidence_count`. Below `MIN_EVIDENCE` (default 4 items across ≥ 2 sittings) the estimate exists but is flagged `insufficient` and **must not be rendered as a number**.
- **Invariant:** every update is derived from `attempt_answers` and is reproducible. A recomputation from raw evidence must reach the same value — mastery is a projection, not a source of truth.
- **Invariant:** never updated synchronously inside the submission transaction.

### Gap and Intervention
- A `Gap` is derived, never hand-entered: `(scope, concept, severity, affected_students, detected_at)`.
- **Invariant:** an `Intervention` stamps `baseline_mastery` at creation. Improvement is measured against that stamp and nothing else.
- **Invariant:** a gap resolves only on new evidence, never on the passage of time or on a teacher marking it done.

### ParentLink
- **Invariant:** consent is explicit, recorded with a timestamp and the granting actor.
- **Invariant:** scope is read-only, restricted to performance data. Tutor conversations, mistake-bank contents and free-text answers are outside it.

## 3. State machines

**Question**
```
  DRAFT ──▶ IN_REVIEW ──▶ APPROVED ──▶ ARCHIVED
    │           │              │
    │           └──▶ REJECTED  └──▶ (edit) ──▶ new version, DRAFT
    └──▶ (delete, only while never used)
```

**Assessment**
```
  DRAFT ──▶ PUBLISHED ──▶ CLOSED ──▶ ARCHIVED
    ▲           │
    └── copy ───┘   (a published assessment is never re-opened for editing)
```

**Attempt**
```
  IN_PROGRESS ──▶ SUBMITTED ──▶ SCORED ──▶ RELEASED
       │                            ▲
       ├── auto-submit at expiry ────┤
       └── swept by cron if abandoned┘
```

**Gap**
```
  DETECTED ──▶ ACKNOWLEDGED ──▶ INTERVENING ──▶ RESOLVED
       │                              │
       └──────────────────────────────┴──▶ PERSISTING  (re-tested, still below)
```

`PERSISTING` exists because a gap that survived an intervention is the most important
signal in the product, and it must not be indistinguishable from a fresh one.

## 4. Where mastery comes from

```
  attempt_answers  (evidence: correct?, difficulty, time_taken, attempt date)
        │
        ▼
  concept_evidence   one row per answer, per concept the question maps to
        │
        ▼
  student_concept_mastery   the estimate + uncertainty + evidence count
        │
        ├──▶ learning_gaps        (thresholded, aggregated by scope)
        ├──▶ recommendations      (what to practise next)
        └──▶ reports             (what a parent reads)
```

`concept_evidence` is kept as an append-only ledger rather than being folded straight
into the estimate. The estimator will change — its first version is deliberately simple
and its third will not be — and every past estimate must be recomputable from evidence
when it does. Without the ledger, changing the algorithm silently rewrites history and
no one can tell whether students improved or the formula did.

## 5. Question–concept mapping

A question maps to **one primary learning outcome** and zero or more secondary ones.

- Primary carries full evidence weight.
- Secondary carries partial weight (default 0.4).
- A question with no outcome mapping is not `APPROVED`-able. An unmapped question can be scored but can never inform mastery, which makes it worthless to the part of the product that matters.
