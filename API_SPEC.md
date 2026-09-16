# API Specification

REST over Next.js route handlers. Server Components read directly through `core/`; the
routes below exist for mutations, for the student client (which must work offline and
retry), and for anything a background job or an external integration calls.

## 1. Conventions

**Base:** `/api`. **Version:** in the path only when a breaking change arrives; unversioned
until then.

**Auth:** session cookie. No API keys for user-facing routes. Service-to-service uses a
bearer token with its own principal.

**Content type:** `application/json`, UTF-8.

**Errors** — one shape everywhere:

```json
{
  "error": {
    "code": "ATTEMPT_ALREADY_SUBMITTED",
    "message": "This attempt was submitted at 10:42. Your answers are saved.",
    "details": { "attemptId": "…", "submittedAt": "…" },
    "requestId": "req_01J…"
  }
}
```

`message` is shown to a user, so it is written for one. `code` is stable and is what
clients branch on. `requestId` appears in the response header and in every log line for
that request.

| Status | Meaning here |
|---|---|
| 400 | Validation failed — `details` names the fields |
| 401 | No session, or expired |
| 403 | Authenticated, not permitted |
| 404 | Not found **or not permitted to know it exists** — cross-tenant reads are always 404, never 403 |
| 409 | State conflict (already submitted, already published) |
| 422 | Semantically invalid (blueprint marks do not sum) |
| 429 | Rate limited — `Retry-After` set |
| 500 | Ours. `requestId` is the only useful thing in the body. |

Cross-tenant access returning 404 rather than 403 is deliberate: a 403 confirms the row
exists, which is itself a leak.

**Idempotency:** every unsafe route accepts `Idempotency-Key`. Attempt submission
additionally carries `clientAttemptId` in the body, because the student client generates
it before it has ever reached the network.

**Pagination:** cursor-based. `?limit=50&cursor=…` → `{ data: [...], nextCursor: … }`.
Offset pagination is not offered; it drifts under concurrent writes.

**Trailing slashes:** the app sets `trailingSlash: true`, which applies to route
handlers. `POST /api/x` 308-redirects to `/api/x/` and **the body silently vanishes on
the redirect**. Clients post to the slashed form. This is written down because it costs
an afternoon every time it is rediscovered.

---

## 2. Auth

```
POST   /api/auth/signup/            { email, password, fullName, orgName, orgType }
POST   /api/auth/signin/            { email, password }        teachers
POST   /api/auth/otp/request/       { phone }
POST   /api/auth/otp/verify/        { phone, code }             students
POST   /api/auth/signout/
POST   /api/auth/switch-org/        { organizationId }   → rotates the session
GET    /api/auth/session/           → { user, organization, role, entitlements }
POST   /api/auth/password/forgot/   { email }
POST   /api/auth/password/reset/    { token, password }
POST   /api/invitations/accept/     { token, password? }
```

`GET /api/auth/session/` returns entitlements alongside identity so the client can hide
what the plan does not include — while the server still enforces it, because a hidden
button is not a permission check.

---

## 3. Curriculum (read-only for tenants)

```
GET /api/curriculum/boards/
GET /api/curriculum/subjects/?boardId=&gradeId=
GET /api/curriculum/chapters/?subjectId=
GET /api/curriculum/topics/?chapterId=
GET /api/curriculum/outcomes/?topicId=|chapterId=
GET /api/curriculum/tree/?subjectId=      → the whole tree, one request, cacheable
```

`/tree/` exists because the assessment builder needs the entire subject at once and six
round trips to draw one picker is a slow first impression on the screen that decides
whether a teacher stays.

---

## 4. Classes and roster

```
GET    /api/classes/
POST   /api/classes/                    { name, gradeId, subjectId, academicYear }
GET    /api/classes/{id}/
PATCH  /api/classes/{id}/
DELETE /api/classes/{id}/               soft delete; 409 if attempts exist

GET    /api/classes/{id}/students/
POST   /api/classes/{id}/students/      { students: [{ fullName, phone?, rollNumber? }] }
POST   /api/classes/{id}/students/import/   multipart CSV → { jobId }
GET    /api/imports/{jobId}/            → { status, processed, failed, errors[] }
DELETE /api/classes/{id}/students/{sid}/    sets left_at; never deletes history
POST   /api/classes/{id}/join-code/         rotate
```

CSV import is a job with a dry-run: `?dryRun=true` returns the parse result and the
errors without writing. A teacher importing 200 students should see what will happen
before it happens.

---

## 5. Questions

```
GET    /api/questions/?subjectId=&chapterId=&outcomeId=&difficulty=&type=
                      &status=&visibility=&q=&cursor=
POST   /api/questions/                  create as DRAFT
GET    /api/questions/{id}/
PATCH  /api/questions/{id}/             creates a new version if APPROVED
POST   /api/questions/{id}/approve/     → APPROVED, stamps approver
POST   /api/questions/{id}/reject/      { reason }
DELETE /api/questions/{id}/             only if never used
GET    /api/questions/{id}/versions/
GET    /api/questions/{id}/stats/
POST   /api/questions/bulk-approve/     { ids: [] }
```

`GET /api/questions/` never returns `answer_key` to a student session, at any status,
under any filter. That is a policy check in `core`, not a `select` in a route.

---

## 6. Assessments

```
GET    /api/assessments/?status=&classId=&cursor=
POST   /api/assessments/                { title, subjectId, gradeId, durationMinutes }
GET    /api/assessments/{id}/
PATCH  /api/assessments/{id}/           409 if PUBLISHED
DELETE /api/assessments/{id}/

PUT    /api/assessments/{id}/blueprint/ { counts, difficultyMix, typeMix, outcomeIds }
POST   /api/assessments/{id}/questions/ { questionIds: [], position? }
DELETE /api/assessments/{id}/questions/{aqId}/
PATCH  /api/assessments/{id}/questions/reorder/   { order: [aqId] }

POST   /api/assessments/{id}/validate/  → { valid, issues[] }   never publishes
POST   /api/assessments/{id}/publish/   freezes question versions
POST   /api/assessments/{id}/close/
POST   /api/assessments/{id}/duplicate/ → a new DRAFT
```

`/validate/` is separate from `/publish/` so the builder can show problems continuously
without the user fearing that pressing something will publish.

---

## 7. Assignments

```
GET    /api/assignments/?classId=&status=
POST   /api/assignments/         { assessmentId, classId?, studentIds?,
                                   opensAt, closesAt, maxAttempts, resultsPolicy }
GET    /api/assignments/{id}/
PATCH  /api/assignments/{id}/    window and policy only, never the questions
POST   /api/assignments/{id}/cancel/
GET    /api/assignments/{id}/progress/    → per-student: not started | in progress | submitted
                                                                        [not built]
POST   /api/assignments/{id}/release/     releases results to students
```

Progress is folded into `GET /api/assignments/{id}/` and the results routes below
rather than living on its own, so a teacher's page makes one request.

**`POST .../release/` is idempotent**: a second press returns the first release time
with 200 and an `alreadyReleased` flag. It is also permitted while marking is
outstanding, and reports `pendingPapers` — holding twenty students back for four
unmarked papers helps nobody, and those four already see "marked so far" with the
marks still owed named.

---

## 8. The attempt path — the routes that must not fail

```
GET  /api/student/assignments/            what I can take, and when
POST /api/attempts/                       { assignmentId, clientAttemptId }
GET  /api/attempts/{id}/                  questions WITHOUT answer keys
PATCH /api/attempts/{id}/answers/         { answers: [{ aqId, response, timeSpent,
                                                        markedForReview, clientSeq }] }
POST /api/attempts/{id}/heartbeat/        → { serverTime, expiresAt, status }
POST /api/attempts/{id}/submit/           { reason: MANUAL | TIMEOUT }
GET  /api/attempts/{id}/result/           403 until RELEASED            [not built]
GET  /api/attempts/{id}/review/           answers + keys + explanations, after release
                                                                        [not built]
```

**Built in slice 7:** everything above except `/result/` and `/review/`. The result
*page* is a server component that calls `studentResult` directly, so the web client
needs no route for it; `/result/` lands when something other than this app needs a
score, and `/review/` belongs with the diagnosis work, where showing a student the key
is part of a larger conversation rather than a data dump.

**Student sign-in is its own route**, not a variant of `/api/auth/signin/`. The two
flows share nothing: one takes a password and the other issues and consumes a
credential with a rate limit, a guess limit and a five-minute life. Folding them into
one handler would mean a branch at the top of the most security-sensitive route in the
product.

**`POST /api/attempts/`** is idempotent on `(assignmentId, clientAttemptId)`. Called
twice, it returns the same attempt. A student on a flaky connection tapping Start twice
must not create two sittings.

**`PATCH .../answers/`** accepts a batch, is idempotent per `(aqId, clientSeq)`, and
applies last-write-wins per question by `clientSeq`. The client queues answers in
localStorage — not IndexedDB as originally planned: the queue is at most one small
record per question, and a synchronous write that survives the tab being killed is
worth more here than the extra capacity of an async store. Offline, 401 and 500 all mean *"not now"* —
the queue survives and retries. A student mid-exam is never blocked and never loses
work.

**`POST .../heartbeat/`** returns authoritative server time. The client displays
`expiresAt - serverTime`, corrected for observed drift. **The countdown is never
accumulated locally.** A phone that backgrounds the tab for forty minutes must come
back with the correct remaining time, and a counted clock will not.

**`POST .../submit/`** is the flow in `ARCHITECTURE.md` §7. Returns the score
synchronously; queues everything interpretive. Submitting twice returns the first
result with 200 and an `alreadySubmitted` flag — not a 409, because the client that
retried did nothing wrong.

---

## 9. Results and analytics

```
GET  /api/assignments/{id}/results/            cohort figures + per-student rows
GET  /api/assignments/{id}/results/questions/  item analysis
GET  /api/assignments/{id}/marking/            written answers awaiting a person
POST /api/marking/{answerId}/                  { awardedMarks | scores, feedback? }
GET  /api/student/mastery/                     my own concept mastery
GET  /api/students/{id}/mastery/               a teacher reading one student
GET  /api/classes/{id}/analytics/              per concept + the student grid
GET /api/students/{id}/performance/            trend, subject breakdown            [not built]
GET  /api/classes/{id}/gaps/                   prioritised learning gaps
POST /api/gaps/{id}/acknowledge/               "I have seen this" — never "this is fixed"
POST /api/gaps/{id}/intervene/                 { kind, note? } — stamps the baseline
GET  /api/gaps/{id}/remedial/                  what one click would build
POST /api/gaps/{id}/remedial/                  { opensAt, closesAt } — builds it
POST /api/interventions/{id}/measure/          reads mastery now, records it once
POST /api/student/join/                        { code } — join a class with its code

Billing is read through `can(organizationId, key)` in `core/billing`, not through a
route: every gated capability is an `entitlements` row reached via the active
subscription, and **no price is hard-coded anywhere**. A missing row means "not
included", never "unlimited".
GET /api/organizations/analytics/              institute KPIs                      [phase 2]
```

**Class analytics reports its denominator, always.** Every concept carries `measured`
and `total`, and below `MIN_MEASURED` measured students `meanEstimate` and `band` are
null. Averaging the three students who happen to have enough evidence and calling it
the class is arithmetically correct and a false claim, so the API does not make it.
There is deliberately no single class-mastery score: a mean across concepts moves when
the syllabus moves, and it is exactly the figure that would get compared between
teachers.

**Results are scoped to the ASSIGNMENT, not the assessment.** One paper may be given
to three classes in three windows; a mean across all of them describes no class that
exists. The assessment page links to each assignment's results instead.

**Every cohort figure is computed over fully marked papers only**, and `counted`
travels beside it so a client can say *62% across 18 of 24 papers*. Below
`MIN_TO_SUMMARISE` marked papers, `enoughToSummarise` is false and `mean`, `median`,
`highest` and `lowest` are all null — the same refusal as the mastery band below,
made in `core/` so a number that must not be shown is never transmitted.

**The student's result carries `visible` and `reviewable` separately.** `visible` is
the teacher's results policy; `reviewable` additionally requires the window to have
closed or results to have been released, because the answer key is a stronger
disclosure than the score and a class sitting in two sessions must not have the first
session holding the answers. Options, explanations, the correct answer and the
marker's feedback are all null until `reviewable`.

Every mastery response carries `evidenceCount` and `band`, and `band` may be
`INSUFFICIENT`. `estimate` and `confidence` are **null** whenever it is — and they are
null because the column is null, not because the route remembered to strip them. In
TypeScript the refusal is a discriminated union with no `estimate` field on the
INSUFFICIENT arm, so a client that renders one does not compile.

Two thresholds decide it: at least four answers, and enough of their weight surviving
the recency decay. Five answers from eighteen months ago clear the first and not the
second, and the `reason` field says which — `no-evidence`, `too-few-answers` or
`evidence-too-old` are three different things to do something about.

---

## 10. Gaps, practice, mistakes

```
GET  /api/gaps/?scope=&scopeId=&severity=                                       [not built]
POST /api/gaps/{id}/acknowledge/
POST /api/gaps/{id}/intervene/     { kind, note? } → stamps baseline, creates an intervention
GET  /api/gaps/{id}/remedial/      the plan: questions, students, mix, feasibility
POST /api/gaps/{id}/remedial/      builds + publishes + assigns + stamps, in one call
POST /api/interventions/{id}/measure/       reads mastery now and records it, once

GET  /api/copilot/                          my conversations
POST /api/copilot/                          { question, conversationId? } — ask
GET  /api/copilot/{id}/                     one conversation, with citations
POST /api/institute/staff/                  { email, role } — invite a colleague
PATCH /api/institute/staff/{id}/            { role } — change a role
DELETE /api/institute/staff/{id}/           take access away (SUSPENDED, not deleted)
DELETE /api/institute/invitations/{id}/     cancel one nobody accepted
GET  /api/parent/invitation/?token=         unauthenticated preview of a link
POST /api/parent/accept/                    { token, phone, code } — verify, consent, sign in
GET  /api/parent/children/                  the children I have a consented link to
GET  /api/parent/children/{id}/             one child's performance
GET  /api/students/{id}/parents/            who can see this child (teacher)
POST /api/students/{id}/parents/            invite one, for this child only (teacher)
POST /api/parent-links/{id}/revoke/         take access away (teacher)
GET  /api/student/recommendations/          what to practise, or why not
POST /api/practice/sessions/                { conceptId, source, questionCount? }
GET  /api/practice/sessions/{id}/           the set, at the versions served
POST /api/practice/sessions/{id}/answers/   one answer, one immediate verdict

GET  /api/student/mistakes/?status=&conceptId=      my bank, with a summary
GET  /api/student/mistakes/{id}/                    one, at the version I was served
POST /api/student/mistakes/{id}/retry/              { response } — marks it, once more
POST /api/cron/classify-mistakes/                   nightly, batched, FAST tier
```

**`POST /api/marking/{answerId}/` takes a total OR a per-criterion breakdown,
never both.** A request carrying both is a client that has not decided which it
is doing, and whichever the server picked would be a total the marker did not
intend. With `scores`, the total is derived from them — there is no parameter
for it, which is why a marker cannot disagree with their own breakdown.

**A rubric's criteria must sum to the question's marks**, checked when the
question is saved. One adding to 5 on a six-mark question cannot award full
marks, and that is found at the twentieth paper if it is not found at the first.

**A practice set is served one question at a time.** `GET
/api/practice/sessions/{id}/` returns what has been served so far and
`questionCount` is what the set is aiming for. Each answer's response carries
the `next` question, chosen from how the set has gone — two consecutive right
steps the difficulty up, two wrong steps it down, and the ceiling is the level
the set opened at plus one.

### Concepts (platform only)

```
POST   /api/x/curriculum/concepts/                       { name, description? }
PATCH  /api/x/curriculum/concepts/{id}/                   { name, description? }
POST   /api/x/curriculum/concepts/{id}/outcomes/          { outcomeId, weight? }
DELETE /api/x/curriculum/concepts/{id}/outcomes/?outcomeId=
POST   /api/x/curriculum/concepts/{id}/prerequisites/     { prerequisiteId, strength? }
DELETE /api/x/curriculum/concepts/{id}/prerequisites/?prerequisiteId=
```

**There is no DELETE for a concept, and there will not be one.** Nothing has a
foreign key from `concept_evidence` or `student_concept_mastery` to `concepts` —
the two planes are deliberately uncoupled — so a delete would succeed and leave
every estimate derived through it pointing at nothing. Unlink its outcomes
instead: that stops future evidence while leaving history explainable.

**`POST /api/x/curriculum/concepts/suggest/` drafts, and accepts.** One route
for two halves of one review: `action: "draft"` returns proposals and writes
nothing; `action: "accept"` creates the concept and links its outcomes in one
audited action. Nothing is written until a person presses Accept, which is the
entire point.

The model refers to outcomes by INDEX into the list it was shown, never by id —
a mistyped uuid is a link to nothing that looks exactly like a link to
something. An index that was not offered is discarded, not clamped.

**A prerequisite that would close a loop is refused with 400.** Root-cause
analysis walks that graph, and in a cycle every concept is the cause of itself.

**The app role cannot reach any of this**, and not because of a check in a route
handler: `sahayak_app` matches no write policy on the curriculum plane at all.
The role check is the second line of defence.

**Every write is audited**, because a change here changes what every customer
measures at once.

### Reports

```
POST /api/reports/                             { classId | studentUserId, periodStart, periodEnd }
GET  /api/reports/                             ?studentUserId= | ?classId=
```

**There is no PATCH and no DELETE.** A report is written once and never edited:
a parent shown a figure in September must be able to bring that sheet in
December and have it still say the same thing. Running it again SUPERSEDES —
a new row, with the old one kept and marked.

**`classId` is the real call.** A teacher does not write one report before
parents' evening, they write thirty. The response carries a row per student,
and a student whose report was REFUSED is named with the reason — a silent skip
is a parent who gets nothing and a teacher who finds out from them.

**A report refuses below three measured concepts.** A thin report is worse than
none: it is a document, with a date on it, that somebody will act on.

**Both routes are staff-only.** A parent reads their own child's reports through
the parent portal, which resolves consent from the report row itself — a report
id is not a capability.

**There is no PDF endpoint.** The sheet prints to a clean page, and a browser's
Save-as-PDF is the download on every device including a phone.

### The study plan

```
GET  /student/plan                                   (a page, not an endpoint)
```

**There is no API, and that is the design.** The plan is derived at read time
from evidence the product already holds — assignments, mastery, the Mistake Bank
— so there is nothing to fetch, nothing to store and nothing to invalidate.

**There is no route that ticks an item off**, exactly as there is none that
closes a learning gap or resolves a mistake. An item leaves the list when the
work behind it is done and the evidence moves. A plan with checkboxes measures
how tidy a student is.

**`/student/practice?conceptId=` hoists that concept** to the top of the practice page
and marks it *From your plan*. A stale link — the concept was practised, or the
estimate moved — lands on the ordinary page rather than an error, because the
concept simply is not a candidate any more. That is the plan's own rule working.

### The tutor

```
POST /api/tutor/                               { questionId, practiceAnswerId?, studentMistakeId? }
GET  /api/tutor/{questionId}/
```

**There is no `level` parameter, and there will not be one.** The rung is a
function of what this student has already been given on this question. A client
that could ask for `EXPLAIN` first could skip the hint, which is the whole
ladder — and it would make "how much help did this need" a number the page can
choose rather than a record.

**There is no `studentId` either**, for the same reason the Mistake Bank has
none. Both routes are student-only; a teacher gets 404, not 403.

**A refusal is 409, not 402 or 429.** The request was well formed and the answer
is "not right now" — the plan does not include it, the school's month is spent,
or this student has had a lot of help today. The message is written for a
fifteen-year-old, never for a billing page.

**`GET` never 404s on a question never asked about.** It returns an empty
history, because "you have not asked about this yet" is the ordinary state and
the panel opens on it.

**A reply that gives the answer away is replaced before it is returned.**
`withheld: true` says the authored hint was served instead. The response also
carries `canEscalate`, which goes false at the top rung — asking again there
returns the last turn rather than paying for a fourth phrasing of the same idea.

**The Copilot never sends a student's name to the provider.** Students are
`STU_a41f0c` handles in the prompt and real names in the response, re-hydrated
server-side from a map that never leaves the process. The teacher's own question
does reach the provider — it is the question — but never reaches
`ai_generations.input_summary`, which is read by a platform admin during an
incident.

**It refuses twice before it spends anything.** The plan first (a teacher on Free
is told about their plan, not their data), then whether there is anything
measured at all. Neither refusal opens a generation record. It is the one
DEEP-tier feature in the product, at `effort: "xhigh"`, so a call that could not
have produced anything useful is the most expensive mistake available.

**Metered on `copilot_questions_per_month`**, not against question generation.
Two different promises; a teacher who asked five questions must still be able to
set a test.

**Every answer carries `citations`** — the figures it used, quoted from the
context — so a teacher acting on it across a cohort can find the row it came
from. `insufficientEvidence: true` is a normal response, not an error.

**Every institute route is gated twice**: the authorize matrix says the acting
user may, and `can(organizationId, "admin_console")` says the organization's plan
includes it. Neither implies the other — a solo teacher on Free is an OWNER with
the permission and no console to use it in, and gets 404 rather than a 403 or an
upsell.

**An organization always keeps one owner.** Demoting or removing the last one is
409 at every route, and so is changing your own role. No owner means nobody who
can manage billing, invite anybody, or undo it.

**`DELETE /staff/{id}/` suspends; it does not delete.** The membership row
survives because their papers, their marking and their audit rows point at them.
Their sessions are deleted, because removed-and-still-signed-in is not removed.

**There is no endpoint that ranks teachers by their students' results**, and
there will not be. `teacherActivity` returns papers set, papers written, papers
outstanding and how long the oldest has waited — things a teacher controls. See
the note in `core/institute/kpis.ts` for why.

**A parent's access is a consented edge, not a role.** A PARENT session with no
links gets an empty list from `/children/` and 404 from every child route — which
is the correct answer, not an error. The id in `/children/{id}/` is a claim;
`core/parent/read.ts` re-derives the link before reading anything, so a parent
guessing another family's student id gets the same 404 as one guessing a uuid
that never existed.

**No parent route can return what a child wrote.** The boundary is an ESLint
fence over `src/app/parent/**` and `src/app/api/parent/**` rather than a convention:
those files cannot import `@/core/mistakes`, `@/core/practice`, `@/core/attempts`,
`@/core/results`, `@/core/analytics`, `@/core/gaps`, or any `@/db/*` path. The
reason is not compliance theatre — a child who believes a parent reads every
question they ask stops asking questions.

**`/invitation/` and `/parent/link/[token]` are unauthenticated by necessity**, and
carry only what identifies the link: the child's name, the centre's name, and the
last four digits of the number the code goes to. Nothing about the child's work.

**Accepting is one call.** Verify the code, create the account if there is none,
record the consent, issue the session. Splitting it would leave a verified phone
with no account, or a consent with no session — a parent who has proved who they
are and still cannot get in. A wrong number returns the same message as an
expired link, because distinguishing them turns the URL into a way of testing
which numbers belong to which children.

**Marks follow the teacher's release policy**, through the same `resultsVisible()`
the student's own pages use. A parent seeing a mark before their child does turns
a result into an ambush. The sitting itself is never hidden — that they sat it is
not the mark.

**There is no `complete` route.** A set finishes when its last question is
answered — a separate call would be a second thing to get wrong, and a set that
was answered but never "submitted" would sit in limbo owning evidence nobody had
written. Finishing is what triggers the ledger write.

**Practice counts towards mastery, at a reduced weight.** Evidence rows are
stamped `source: PRACTICE` and carry `PRACTICE_WEIGHT` times the concept-mapping
weight. Excluding practice entirely would mean a `PRACTICE_SET` intervention
could never be measured as having worked; counting it at parity would make
mastery a function of persistence. Nothing is written until the set is finished,
and an abandoned set contributes nothing.

**The verdict comes back with the answer, per question.** `POST /answers/`
returns `correct`, `explanation`, `correctAnswer` and `correctKeys` in the same
response — that immediacy is the whole point. Answering the third question does
not unseal the rest: `GET` reveals those fields only on questions already
answered. Answering the same question twice returns 409.

**A question answered correctly is not served again for 30 days**, across
sessions. One that was answered wrongly comes back immediately.

**`GET /recommendations/` returns the refusal as data**, not an empty list.
`{ ok: false, reason }` distinguishes `nothing-measured`, `bank-too-thin` and
`nothing-to-practise` — a client handed `[]` for all three would show the same
encouraging nothing to a student who has never sat a test and to one who is on
top of everything.

**Every mistake route is scoped to the session's own user, and none takes a
student id.** Not only tenancy: the mistake bank is deliberately outside a
parent's read scope (SECURITY_MODEL.md), and a `?studentId=` would be the first
crack in that. A classmate on the same paper gets 404 on the row and on the retry.

**A mistake is a settled wrong answer.** Objective answers settle at submission,
a blank included; a written one settles only when a person has marked it, at
which point `awardMarks` re-runs the recorder — and raising it to full marks
deletes the row rather than leaving a stale card in a student's bank.

**The explanation and the correct answer are absent from the payload until they
retry**, not hidden by CSS. `revealed` says which state the row is in. A bank
that opens with the answer showing is a reading exercise, and the value is
entirely in the attempt that comes first.

**A correct retry returns `status: "RETRIED"`, never `"RESOLVED"`.** Re-answering
a question whose answer you have seen mostly measures memory. Resolution needs a
*different* question on the same concept answered correctly afterwards, at full
marks, and it happens on its own the next time one is marked. There is no route
that closes a mistake, exactly as there is none that closes a gap.

**`mistakeType` may be `UNCLASSIFIED`, and two fields say why.** `classified` is
false when nothing named a type; `examined` is false only when nothing has looked
yet. They come apart for a wrong true/false, which is settled by rule as "there
is nothing here that says why" — a finding, not a queue entry.

**Classification is nightly and batched, never on submission.** Rules type the
blanks, the timed-out papers, the rushed-but-competent answers and the binary
questions at zero cost; only the ambiguous remainder reaches a FAST-tier model,
in batches of 20 sharing one cached prefix. Nothing in the product needs a
mistake typed within the second — the question, the marks and the explanation
are all there regardless, and the card says plainly when nothing has looked yet.

**The baseline is stamped at creation and never updated.** `POST /intervene/` and
`POST /remedial/` both write `baselineMastery`, `baselineStudentCount` and
`targetMastery` in the same transaction that creates the row, and nothing in the API
can change them afterwards. Without that stamp "improvement" is measured against
whatever mastery happens to be when somebody looks, which always flatters the
intervention — and an unfalsifiable improvement claim is the thing that eventually
loses the customer.

**`measure` is a POST, not a GET, and it works once.** The outcome has to be a
recorded reading rather than a figure recomputed on every page load, or the same
intervention shows a different result each week as evidence accumulates. A second
call returns 409. There is deliberately no route that un-measures one and no field
that accepts an outcome figure from the caller: a measurement a teacher could type in
is not a measurement.

**It records failures.** `metTarget: false` is a normal response, and the panel says so
in words. A measured failure is the most valuable row in the table — it is what turns
the gap into PERSISTING at the next detection pass, which is the signal that whatever
was tried did not work.

**Only one open intervention per gap.** A second `intervene` or `remedial` while one is
PLANNED or ACTIVE returns 409: with two running, whichever is measured second takes
credit for both.

**`GET /remedial/` and `POST /remedial/` run the same code.** The preview names the
question count, the marks, the duration, the difficulty mix and exactly which students
would receive it, and it cannot disagree with what the POST then does. Where the bank
is too thin it refuses with the number — *your bank has 2 approved questions on
Similarity of triangles, and a second reading needs at least 4* — rather than padding
the paper with questions on a neighbouring concept, which would destroy the clean
second reading the sitting exists to produce.

**The paper is assigned to the students who are below the line, not to the class.**
Targets are recomputed at build time from current mastery, so a student who has since
caught up is not made to sit it and one who has fallen behind since the gap was found
is included.

**A gap this tenant cannot see answers 404, never 409.** A conflict would confirm the
row exists, which is itself the leak.


---

## 11. AI

Every generative route returns a job id. None of them block.

```
POST /api/ai/questions/generate/     { outcomeIds, count, difficultyMix, typeMix } → { jobId }
POST /api/ai/assessments/generate/   { assessmentId } → { jobId }
GET  /api/ai/jobs/{jobId}/           → { status, stages[], produced, requested, errors[] }
POST /api/ai/questions/{id}/validate/
POST /api/ai/analyze/class/          { classId } → { jobId }
POST /api/ai/copilot/                { message, context } → SSE stream
POST /api/ai/tutor/explain/          { attemptAnswerId, mode: 'hint'|'steps'|'simple' }
POST /api/ai/reports/generate/       { studentId, period } → { jobId }
```

`GET /api/ai/jobs/{jobId}/` returns **real stages with real counts** — the same
structure the progress checklist in `DESIGN_SYSTEM.md` §9 renders. There is no
percentage field, because we would have to invent it.

`/api/ai/tutor/explain/` receives the verified question, the official answer key and
the student's response as context. The response is rendered beside the stored key, and
the prompt forbids contradicting it. **An AI explanation never overrides an official
answer** — if the model disagrees with the key, that is a question-quality signal routed
to the teacher's review queue, not a correction shown to a student.

---

## 12. Billing, notifications, admin, cron

```
GET  /api/plans/
GET  /api/subscription/
POST /api/subscription/change/     { planId }
GET  /api/subscription/usage/

GET  /api/notifications/?unread=
POST /api/notifications/{id}/read/

GET  /api/admin/organizations/          platform admin, audited
GET  /api/admin/ai/usage/?orgId=&from=&to=
POST /api/admin/curriculum/import/

POST /api/cron/sweep-attempts/     bearer CRON_SECRET
POST /api/cron/drain-jobs/
POST /api/cron/classify-mistakes/  nightly Batch API run
POST /api/cron/purge-retention/
```

---

## 13. Webhooks (Phase 3)

Outbound, for school MIS integration. Signed with HMAC-SHA256 over the raw body,
timestamp in the header, 5-minute tolerance, at-least-once delivery with exponential
backoff and a replayable delivery log.

Events: `assessment.published`, `attempt.submitted`, `results.released`,
`gap.detected`, `student.enrolled`.
