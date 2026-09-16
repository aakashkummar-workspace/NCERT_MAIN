# Database Schema

PostgreSQL 16. Prisma owns the tables; **row-level security policies live in
hand-written migration SQL**, because Prisma cannot express them and a policy that is
not in version control is a policy that does not exist.

## 0. Conventions

- Primary keys are `uuid` (v7 where possible, for index locality).
- `created_at timestamptz not null default now()`, `updated_at timestamptz` on every mutable table.
- Soft delete is `deleted_at timestamptz`, and only where a hard delete would destroy history someone can be asked to defend.
- Money is `integer` in paise. Never a float.
- Enums are Postgres enums.
- **Every tenant-plane table has `organization_id uuid not null`**, an index on it, and an RLS policy. There are no exceptions, and a table added without one fails the schema test in CI.

---

## 1. Curriculum plane — global, platform-owned

No `organization_id`. Readable by every tenant, writable only by a platform admin.

```sql
boards            id, code ('CBSE'), name, country, created_at
grades            id, board_id, number (9|10), label
subjects          id, board_id, grade_id, code, name, sort_order
                  unique (board_id, grade_id, code)

chapters          id, subject_id, number, title, source_ref, sort_order
                  unique (subject_id, number)

topics            id, chapter_id, title, sort_order

learning_outcomes id, topic_id, code, statement,
                  bloom_level     enum(REMEMBER,UNDERSTAND,APPLY,ANALYSE,EVALUATE,CREATE),
                  competency      enum(KNOWLEDGE,UNDERSTANDING,APPLICATION,
                                       PROBLEM_SOLVING,ANALYSIS,EVALUATION),
                  typical_marks   int,
                  sort_order
                  unique (topic_id, code)

concepts          id, name, slug, description
                  -- the unit mastery is measured against
concept_outcomes  concept_id, learning_outcome_id, weight numeric(3,2)
                  primary key (concept_id, learning_outcome_id)

concept_prerequisites  concept_id, prerequisite_concept_id, strength numeric(3,2)
                  primary key (concept_id, prerequisite_concept_id)
                  -- powers "you are stuck on X because you never had Y"
                  check (concept_id <> prerequisite_concept_id)

curriculum_versions  id, board_id, academic_year, published_at, notes
```

`concepts` is separate from `learning_outcomes` because the same idea ("ratio and
proportion") is tested by outcomes in several chapters and in two subjects. Measuring
mastery per outcome fragments the evidence; measuring per concept concentrates it.

`concept_prerequisites` is the root-cause graph. It is what turns "weak in
Trigonometry" into "weak in Trigonometry *because* similar triangles never landed" —
which is a different, and far more useful, sentence for a teacher.

---

## 2. Identity and tenancy

```sql
organizations     id, name, slug unique, type enum(SOLO_TEACHER,TUITION_CENTRE,
                     COACHING_INSTITUTE,SCHOOL), board_id, academic_year,
                     status enum(TRIAL,ACTIVE,SUSPENDED,CANCELLED),
                     settings jsonb, created_at, deleted_at

users             id, email citext unique null, phone text unique null,
                  password_hash text null,        -- argon2id; null for OTP-only users
                  full_name, avatar_url, locale default 'en-IN',
                  status enum(PENDING,ACTIVE,DISABLED),
                  last_login_at, created_at, deleted_at
                  check (email is not null or phone is not null)

memberships       id, organization_id, user_id,
                  role enum(OWNER,ADMIN,TEACHER,STUDENT,PARENT),
                  status enum(INVITED,ACTIVE,SUSPENDED),
                  invited_by, joined_at, left_at
                  unique (organization_id, user_id)

sessions          id, user_id, organization_id, membership_id,
                  token_hash bytea unique,        -- the raw token is never stored
                  user_agent, ip inet,
                  created_at, last_seen_at, expires_at, revoked_at

invitations       id, organization_id, email/phone, role, token_hash,
                  invited_by, expires_at, accepted_at, revoked_at

teacher_profiles  user_id pk, organization_id, subjects uuid[], qualification, bio
student_profiles  user_id pk, organization_id, roll_number, grade_id,
                  guardian_phone, admission_year
                  unique (organization_id, roll_number)
parent_profiles   user_id pk, organization_id, relationship

parent_student_links  id, organization_id, parent_user_id, student_user_id,
                  relationship enum(FATHER,MOTHER,GUARDIAN),
                  consent_granted_at, consent_granted_by,
                  scope jsonb default '{"performance":true}',
                  revoked_at
                  unique (parent_user_id, student_user_id)
```

`sessions.token_hash` — the cookie carries a random 32-byte token; only its SHA-256
lands in the database. A database leak must not be a session-hijack kit.

---

## 3. Teaching structures

```sql
classes           id, organization_id, name ('Class 10-A'), grade_id, subject_id,
                  academic_year, owner_teacher_id, status enum(ACTIVE,ARCHIVED),
                  join_code text unique null, created_at, deleted_at

class_teachers    class_id, teacher_user_id, role enum(PRIMARY,ASSISTANT)
                  primary key (class_id, teacher_user_id)

class_enrolments  id, organization_id, class_id, student_user_id,
                  joined_at, left_at, status enum(ACTIVE,LEFT,REMOVED)
                  unique (class_id, student_user_id, joined_at)
```

Enrolment is time-bounded so a mid-year transfer keeps its history without polluting
the new class's past results.

---

## 4. Content

```sql
questions         id, organization_id null, created_by, visibility enum(GLOBAL,
                     ORGANIZATION,PRIVATE),
                  subject_id, chapter_id, primary_outcome_id,
                  type enum(MCQ,MULTI_SELECT,TRUE_FALSE,FILL_BLANK,MATCH,
                            ASSERTION_REASON,VSA,SA,LA,CASE_STUDY,NUMERIC),
                  difficulty enum(EASY,MEDIUM,HARD),
                  marks int, expected_time_seconds int,
                  status enum(DRAFT,IN_REVIEW,APPROVED,REJECTED,ARCHIVED),
                  current_version_id, source enum(MANUAL,AI_GENERATED,IMPORTED),
                  ai_generation_id null,
                  approved_by null, approved_at null,
                  content_hash bytea,          -- exact-duplicate detection
                  embedding vector(1024) null, -- near-duplicate detection (pgvector)
                  created_at, deleted_at
                  check ((visibility = 'GLOBAL') = (organization_id is null))
                  check (status <> 'APPROVED' or approved_by is not null)

question_versions id, question_id, version int,
                  stem text, stem_format enum(TEXT,MARKDOWN,LATEX),
                  options jsonb,      -- [{key,text,is_correct}]
                  answer_key jsonb,   -- null for subjective types
                  explanation text, hint text,
                  assets jsonb,       -- [{role,url,alt}]
                  rubric jsonb,       -- criteria for subjective marking
                  created_by, created_at
                  unique (question_id, version)

question_outcomes question_id, learning_outcome_id, weight numeric(3,2),
                  is_primary boolean
                  primary key (question_id, learning_outcome_id)

question_stats    question_id pk, organization_id null,
                  times_served int, times_correct int,
                  p_value numeric(4,3),        -- observed difficulty
                  discrimination numeric(4,3), -- point-biserial
                  avg_time_seconds int, last_calibrated_at
```

`question_versions` is why an approved question is immutable: an attempt records the
version it was served, so a paper written in August still marks the way it did in
August even after the question is edited in December.

`question_stats` is what eventually replaces the teacher's difficulty guess with
observed difficulty. It is populated from Phase 2 and read defensively — a `p_value`
from 11 responses is not a fact.

---

## 5. Assessment

```sql
assessments       id, organization_id, created_by, class_id null,
                  title, description, subject_id, grade_id,
                  duration_minutes int, total_marks int, passing_marks int null,
                  blueprint jsonb,   -- the declared plan; see below
                  status enum(DRAFT,PUBLISHED,CLOSED,ARCHIVED),
                  settings jsonb,    -- shuffle, negative marking, review policy,
                                     -- attempts allowed, calculator, navigation
                  published_at, closed_at, created_at, deleted_at

assessment_questions  id, organization_id, assessment_id,
                  question_id, question_version_id,   -- frozen at publish
                  position int, marks int, section text null,
                  is_optional boolean default false
                  unique (assessment_id, position)

assignments       id, organization_id, assessment_id,
                  class_id null, assigned_by,
                  opens_at, closes_at, duration_override_minutes null,
                  max_attempts int default 1,
                  results_policy enum(IMMEDIATE,AFTER_CLOSE,MANUAL) default AFTER_CLOSE,
                  status enum(SCHEDULED,OPEN,CLOSED,CANCELLED),
                  created_at

assignment_targets  id, assignment_id, student_user_id
                  -- present only for a subset assignment; empty means the whole class
                  unique (assignment_id, student_user_id)
```

`blueprint` as `jsonb` is deliberate — it is a declaration read only by the builder and
the generator, never joined against. Everything queried lives in real columns.

---

## 6. Attempts

```sql
attempts          id, organization_id, assignment_id, student_user_id,
                  client_attempt_id uuid,    -- idempotency key from the client
                  attempt_number int default 1,
                  status enum(IN_PROGRESS,SUBMITTED,SCORED,RELEASED,VOID),
                  started_at, duration_ms int, expires_at,
                  submitted_at, submit_reason enum(MANUAL,TIMEOUT,SWEEP,PROCTOR) null,
                  scored_at, released_at,
                  raw_score numeric(6,2), max_score numeric(6,2),
                  percentage numeric(5,2),
                  time_spent_seconds int,
                  device jsonb, ip inet
                  unique (assignment_id, student_user_id, client_attempt_id)
                  unique (assignment_id, student_user_id, attempt_number)

attempt_answers   id, organization_id, attempt_id,
                  assessment_question_id, question_version_id,
                  response jsonb,            -- shape depends on question type
                  is_correct boolean null,   -- null = not auto-gradable, or unmarked
                  awarded_marks numeric(5,2) null,
                  max_marks numeric(5,2),
                  time_spent_seconds int, visit_count int,
                  marked_for_review boolean default false,
                  answered_at, graded_at,
                  graded_by null, grade_source enum(AUTO,TEACHER,AI_ASSISTED) null
                  unique (attempt_id, assessment_question_id)
```

**`is_correct` is nullable and `awarded_marks` is nullable.** An unmarked subjective
answer scores `null`, never `0`. Only a student who explicitly left a question blank
scores zero. A `null` that becomes a `0` somewhere in an average is how a product tells
a parent their child failed a question nobody has marked yet.

---

## 7. The intelligence layer

```sql
concept_evidence  id, organization_id, student_user_id, concept_id,
                  attempt_answer_id, is_correct boolean,
                  difficulty enum, weight numeric(3,2),
                  observed_at timestamptz
                  -- append-only ledger; every estimate is recomputable from this
                  index (student_user_id, concept_id, observed_at desc)

student_concept_mastery
                  id, organization_id, student_user_id, concept_id,
                  estimate numeric(4,3),        -- 0..1
                  confidence numeric(4,3),      -- 0..1
                  evidence_count int,
                  sitting_count int,
                  band enum(CRITICAL,FRAGILE,DEVELOPING,SECURE,INSUFFICIENT),
                  previous_estimate numeric(4,3) null,
                  trend enum(IMPROVING,STABLE,DECLINING,UNKNOWN),
                  last_evidence_at, computed_at
                  unique (student_user_id, concept_id)

learning_gaps     id, organization_id,
                  scope enum(STUDENT,CLASS,SUBJECT_COHORT),
                  scope_id uuid,                -- student, class, or grade+subject
                  concept_id, severity enum(HIGH,MEDIUM,LOW),
                  affected_student_count int, mean_estimate numeric(4,3),
                  status enum(DETECTED,ACKNOWLEDGED,INTERVENING,RESOLVED,PERSISTING),
                  root_cause_concept_id null,   -- via concept_prerequisites
                  detected_at, resolved_at
                  unique (scope, scope_id, concept_id)

interventions     id, organization_id, learning_gap_id, created_by,
                  kind enum(REMEDIAL_ASSESSMENT,PRACTICE_SET,LESSON_PLAN,MANUAL),
                  assessment_id null, practice_template_id null,
                  baseline_mastery numeric(4,3),    -- stamped at creation
                  baseline_student_count int,
                  target_mastery numeric(4,3),
                  outcome_mastery numeric(4,3) null,
                  status enum(PLANNED,ACTIVE,MEASURED,ABANDONED),
                  created_at, measured_at

sms_messages      id, organization_id null, phone, template enum(LOGIN_CODE,
                  PARENT_INVITE),
                  status enum(QUEUED,SENT,DELIVERED,FAILED,SKIPPED),
                  provider, provider_message_id null, cost_micros null,
                  error null, created_at
                  -- organization_id is NULL for a sign-in code: a student has
                  -- no tenant until the code tells us which one. So the row
                  -- belongs to nobody, the app role cannot write it, and the
                  -- write goes through app_sms_record() — the same pre-tenant
                  -- seam app_auth_issue_code sits in.
                  -- The platform console holds a COLUMN grant here, not a
                  -- table grant: it can read cost and status, never `phone`.
                  index (phone, created_at desc)

reports           id, organization_id, student_user_id, class_id null,
                  kind enum(TERM),
                  period_start, period_end,
                  generated_by_id, generated_at,
                  payload jsonb,               -- the whole sheet, as it read
                  payload_version int          -- a document outlives its writer
                  -- Written ONCE and never updated. A parent shown a figure in
                  -- September must be able to bring that sheet in December.
                  -- Regenerating inserts a NEW row and the old one is kept, so
                  -- there is deliberately no unique (student, period).
                  index (organization_id, student_user_id, generated_at desc)

student_mistakes  id, organization_id, student_user_id,
                  question_id, question_version_id, attempt_answer_id,
                  concept_id, mistake_type enum(CONCEPTUAL,PROCEDURAL,CARELESS,
                                                UNATTEMPTED,MISREAD,TIME_PRESSURE),
                  status enum(UNRESOLVED,RETRIED,RESOLVED),
                  retry_count int default 0, resolved_at, created_at
                  index (student_user_id, status, concept_id)

practice_sessions id, organization_id, student_user_id,
                  source enum(RECOMMENDED,MISTAKE_REVIEW,SELF_SELECTED,ASSIGNED),
                  concept_ids uuid[], question_count int,
                  started_at, completed_at, score numeric(5,2)

practice_answers  id, practice_session_id, question_id, question_version_id,
                  response jsonb, is_correct boolean, time_spent_seconds int

recommendations   id, organization_id, audience enum(STUDENT,TEACHER,PARENT),
                  recipient_user_id, kind, priority int,
                  concept_id null, payload jsonb,
                  rationale text,               -- always human-readable
                  valid_until, acted_on_at, dismissed_at, created_at
```

`mistake_type` is classified by a cheap model, or by rule where a rule suffices — an
unattempted question needs no model. `CARELESS` versus `CONCEPTUAL` is the distinction
that changes what a teacher does, and it is the one worth spending a token on.

---

## 8. AI operations

```sql
ai_generations    id, organization_id null, requested_by,
                  feature enum(QUESTION_GENERATION,QUESTION_VALIDATION,
                               PERFORMANCE_ANALYSIS,TEACHER_COPILOT,STUDENT_TUTOR,
                               REPORT_GENERATION,RECOMMENDATION,CLASSIFICATION),
                  status enum(QUEUED,RUNNING,SUCCEEDED,PARTIAL,FAILED,REFUSED),
                  input_summary jsonb,          -- never raw PII
                  output_ref jsonb,
                  requested_count int, produced_count int, accepted_count int,
                  error_code, error_message,
                  started_at, finished_at

ai_usage          id, ai_generation_id, organization_id null,
                  provider, model, prompt_version,
                  input_tokens int, output_tokens int, cached_input_tokens int,
                  latency_ms int, cost_micros bigint,
                  status, created_at
                  index (organization_id, created_at)
                  index (feature, created_at)

ai_budgets        id, organization_id, period enum(DAY,MONTH),
                  feature null,                 -- null = all features
                  limit_micros bigint, spent_micros bigint,
                  window_start, window_end
                  unique (organization_id, period, feature, window_start)

prompt_versions   id, feature, version, template text, model_tier,
                  schema jsonb, active boolean, created_by, created_at
```

`ai_usage` is written for **every** call including failures, because a retry storm is
invisible in a success-only ledger and is exactly the thing that produces a surprise
bill.

---

## 9. Jobs and eventing

**Built, in migration `20260910094806_webhooks`**, with two deliberate departures
from the sketch below:

- **`organization_id` is NOT NULL on both tables.** Under RLS a NULL organization
  is a row the app role can neither read nor write, so a nullable column here
  would be a seam with no caller — unlike `sms_messages`, where the nullable
  column is the whole point because a student requesting a sign-in code genuinely
  has no tenant yet.
- **Emission is a database trigger, not application code.** The "same
  transaction" guarantee then holds for every path that changes the row —
  including a backfill and the next feature — rather than only for the call sites
  somebody remembered to edit. Each trigger body runs in a subtransaction with
  `exception when others then raise warning`, so a failure to queue an event can
  never fail a teacher's publish, and the triggers are NOT `security definer`, so
  the insert is checked against the tenant policy like any other write.

```sql
outbox            id, organization_id null, topic, payload jsonb,
                  created_at, published_at
                  -- written in the same transaction as the state change

jobs              id, organization_id null, queue, type, payload jsonb,
                  status enum(PENDING,RUNNING,SUCCEEDED,FAILED,DEAD),
                  priority int default 100,
                  attempts int default 0, max_attempts int default 5,
                  run_after timestamptz default now(),
                  locked_by text null, locked_until timestamptz null,
                  last_error text, created_at, finished_at
                  index (status, queue, run_after) where status = 'PENDING'
                  unique (type, dedupe_key) where dedupe_key is not null
```

Claim is a single statement, no Redis:

```sql
update jobs set status='RUNNING', locked_by=$1,
                locked_until=now() + interval '5 minutes', attempts=attempts+1
where id in (
  select id from jobs
  where status='PENDING' and run_after <= now() and queue = $2
  order by priority, run_after
  limit $3
  for update skip locked
)
returning *;
```

A sweeper returns rows whose `locked_until` has passed to `PENDING`. A job that
exhausts `max_attempts` goes `DEAD` and raises an alert rather than disappearing.

---

## 10. Billing

```sql
plans             id, code, name, price_paise int, interval enum(MONTH,YEAR),
                  is_public boolean, sort_order

entitlements      id, plan_id, key, limit_value int null, unlimited boolean
                  -- e.g. max_students, max_teachers, ai_generations_per_month,
                  --      analytics_depth, parent_portal, custom_reports

subscriptions     id, organization_id, plan_id,
                  status enum(TRIALING,ACTIVE,PAST_DUE,CANCELLED,EXPIRED),
                  trial_ends_at, current_period_start, current_period_end,
                  provider, provider_ref, cancelled_at

usage_counters    id, organization_id, key, period_start, value int
                  unique (organization_id, key, period_start)
```

**No price is hard-coded anywhere in the application.** A feature check is
`can(org, 'ai_generations_per_month')`, and the answer comes from
`entitlements` joined through the active subscription.

---

## 11. System

```sql
audit_logs        id, organization_id null, actor_user_id null, actor_role,
                  action, entity_type, entity_id,
                  before jsonb null, after jsonb null,
                  ip inet, user_agent, request_id, created_at
                  index (organization_id, created_at desc)
                  index (entity_type, entity_id)

notifications     id, organization_id, user_id, kind, title, body,
                  action_url, read_at, created_at

files             id, organization_id null, uploaded_by, bucket, object_key,
                  mime, bytes bigint, sha256 bytea, purpose, created_at
```

Audit logs are append-only: an `UPDATE`/`DELETE` trigger raises. Writes that matter —
publishing, grading, overriding a grade, changing a role, exporting data, granting
parent access — are logged whether or not anyone has asked for it yet.

---

## 12. Row-level security

Applied to every tenant-plane table. The pattern:

```sql
alter table attempts enable row level security;
alter table attempts force row level security;   -- applies to the table owner too

create policy tenant_isolation on attempts
  using      (organization_id = current_setting('app.organization_id', true)::uuid)
  with check (organization_id = current_setting('app.organization_id', true)::uuid);
```

`force row level security` is what stops the application's own role — which owns the
tables — from bypassing every policy in the schema. Without it the whole mechanism is
decorative.

Questions carry the extra global-visibility clause:

```sql
create policy question_read on questions for select
  using (
    organization_id is null                                            -- global bank
    or organization_id = current_setting('app.organization_id', true)::uuid
  );

create policy question_write on questions for all
  using      (organization_id = current_setting('app.organization_id', true)::uuid)
  with check (organization_id = current_setting('app.organization_id', true)::uuid);
```

Tenant context is set **transaction-locally**:

```sql
select set_config('app.organization_id', $1, true);
```

The `true` is the point. Under a transaction-mode pooler, a session-level `SET` leaks
onto the next request that borrows the connection, which is a cross-tenant read.

**RLS is the second line, not the first.** Application code still filters by
`organization_id` explicitly and still checks roles. RLS exists to make the day someone
forgets a `where` clause a non-event rather than a breach notification.

### Role-level scoping above RLS

RLS answers "which org". It does not answer "which student". A teacher may read
attempts in their own classes; a student may read only their own. Those live in
`core/identity/authorize.ts` as explicit, unit-tested predicates:

| Actor | Attempts visible |
|---|---|
| Student | `attempt.student_user_id = me` |
| Teacher | attempt's assignment's class is one they teach |
| Institute admin | any in the org |
| Parent | student is linked with active consent, **and** the attempt is `RELEASED` |

---

## 13. Indexes that are not optional

```sql
-- the analytics hot path
create index on attempts (organization_id, assignment_id, status);
create index on attempt_answers (attempt_id);
create index on concept_evidence (student_user_id, concept_id, observed_at desc);
create index on student_concept_mastery (organization_id, concept_id, band);
create index on learning_gaps (organization_id, scope, scope_id, severity);

-- the question bank
create index on questions (organization_id, subject_id, chapter_id, status);
create index on questions (primary_outcome_id) where status = 'APPROVED';
create index on questions using hnsw (embedding vector_cosine_ops);

-- session lookup on every request
create index on sessions (token_hash) where revoked_at is null;
```

## 14. What is deliberately absent

- **No `student` table separate from `users`.** A student is a user with a membership and a profile. Duplicating identity is how a student who becomes a tutor ends up as two people.
- **No denormalised `score` on `assignments`.** Every aggregate is computed or materialised with a stamped `computed_at`. A cached number with no timestamp is a lie waiting for its moment.
- **No `is_deleted` boolean.** `deleted_at` carries when, which is the part anyone actually needs.
- **No cross-tenant foreign keys** other than into the curriculum plane.
