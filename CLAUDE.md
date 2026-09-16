# Sahayak — working notes

AI assessment and personalised learning for CBSE Class 9 & 10. The architecture is
settled in fourteen documents; read [README.md](./README.md) for the index and
[ARCHITECTURE.md](./ARCHITECTURE.md) before writing any server code.

**All twelve MVP slices are built** — design tokens and the component library; auth
and tenancy; organizations, classes and the roster; the curriculum tree and its
editor; the question bank; the assessment builder; assignment; the test player;
results, marking and release; the evidence ledger and the mastery estimator; teacher
analytics; the AI gateway and question generation; learning gaps.

**Since then:** plans and entitlements; the platform console; AI question validation
and the class read; the students index and settings; interventions — the loop
from a detected gap to a measured claim about whether the reteaching worked; and
the Mistake Bank; personalised practice; the parent portal; the institute console; and the AI Teacher Copilot; subjective
grading with rubrics; and adaptive difficulty inside practice.

**Phase 2 is complete except for item-statistics calibration**, which replaces a
question's declared difficulty with its observed `p_value` and needs roughly 50
real responses per item before it can be built at all.

**Phase 3 is now complete except for the two calibration items.** The AI student
tutor — three escalating rungs of help on one question, which never states the
answer and is checked rather than trusted; the study plan — what to do next, in
order, derived at read time and stored nowhere; term reports — stamped,
superseded rather than edited, and printable; concept authoring, which was the
binding constraint on everything measured; exam readiness; institute-level
analytics across cohorts; the internationalisation seam; MIS webhooks on a
transactional outbox; and voice input for written answers.

**What is NOT built, and why it is not effort.** Item-statistics calibration and
IRT calibration both replace a question's declared difficulty with its observed
difficulty. Both need roughly fifty real responses per item; this database has a
handful. The code is writable today and could not be shown to work, and a
calibration that silently produces nonsense corrupts every mastery figure
downstream of it — which is every figure the product exists to produce. They are
waiting on data, not on a decision. See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

**Phase 4 is under way, in IMPLEMENTATION_PLAN.md section 7.** Live exam
monitoring, marks export, teacher-assigned practice and exam series are BUILT.
Cross-school concept benchmarks (7.5) are not, and ship last of the five
because they are the easiest of them to build into a lie. Each is written down
with the refusal it has to make.
**Content arrived in September 2026.** The NCERT import brought 3,857 CBSE
Class 9 and 10 questions and draft outcomes and concepts for every chapter but
Hindi. The drafts await a teacher's review, and the bank must not reach any
school but Sirah Digital until NCERT grants permission. See "The NCERT import"
below.

## Running it

```bash
cp .env.example .env          # then fill in DATABASE_URL and DIRECT_URL
npm install
npm run db:up                 # Docker Postgres on 5434
npm run db:migrate
npm run db:rls                # RLS policies — Prisma cannot express them
npm run db:seed               # CBSE, Class 9 and 10, and their subjects
npm run dev                   # http://localhost:3210
```

## Checks

```bash
npm run verify                # typecheck + lint + unit
npm run test:integration      # needs the database up
npm run audit:rls             # the one that must never be skipped
npm run build && npm start    # then, in another shell:
npm run smoke                 # 872 HTTP checks across twenty-five suites
npm run test:e2e              # 186 browser checks: 13 flows, axe on all 52 routes,
                              # tap targets and layout at 360 / 768 / 1440
npm run test:a11y             # just the accessibility sweep
```

## The rule that shapes the most code

**The acting user and their organization come from the session, never from a request.**
`getSession()` has no overload that accepts an organization id, and there is no
`?orgId=` and no `X-Org-Id` header. An API that cannot express impersonation is the only
kind that reliably does not permit it.

## Non-obvious things to know

### Tenancy

- **`withTenant` sets its own transaction limits, because Prisma's defaults governed
  the whole product and nobody had chosen them.** `$transaction(fn)` with no options
  is `maxWait: 2000, timeout: 5000`, and every tenant query goes through this one
  function. The timeout surfaced as two "flaky" integration tests in different
  suites, both passing alone, both failing with *Transaction already closed* — a
  heatmap over a large class or a term report can legitimately exceed five seconds
  on a loaded database, and when it does the work is already lost. `maxWait` is the
  more dangerous half and had not failed yet: it is how long a caller waits for a
  free connection, a class of thirty submitting in the same minute is exactly a pool
  burst, and submitting goes through here. Raising them is NOT the fix for a slow
  query — a transaction held fifteen seconds holds a connection and its row locks
  for fifteen seconds. They are headroom, and anything routinely approaching the
  timeout is a query to fix.
- **`set_config('app.organization_id', $1, true)` — the `true` is the whole defence.**
  It scopes the setting to the transaction. Under a transaction-mode pooler a
  session-level `SET` leaks onto the next request that borrows the connection, which is
  a cross-tenant read with no error and no log line. `withTenant()` is the only
  sanctioned path; an ESLint rule blocks `@/db/client` everywhere else.

- **The app connects as `sahayak_app`, which is NOT a superuser and does NOT have
  BYPASSRLS.** This matters more than it looks: a superuser bypasses row-level security
  unconditionally, so a tenancy suite run as one passes while proving nothing. Both
  `tests/integration/setup.ts` and `scripts/audit-rls.ts` refuse to proceed otherwise.
  `DIRECT_URL` is the superuser and is used only by migrations and `db:rls`.

- **`force row level security` is on every tenant table.** Without `FORCE`, the table
  owner bypasses every policy and the mechanism is decorative.

- **The RLS audit reads `information_schema`, not a list.** A table added in month six
  without a policy fails `npm run audit:rls` and `tests/integration/rls-coverage.test.ts`
  on the day it is added. Do not turn either into a warning.

### The pre-tenant seam

Sign-in has a real ordering problem: the session token is what *tells* us the tenant, so
resolving it cannot already be inside one. Rather than weaken the policies, the five
reads that must happen first are `SECURITY DEFINER` functions in `prisma/rls.sql` with a
fixed narrow shape — exact identifier in, at most one row of auth columns out.
`src/db/unscoped.ts` is the only module allowed to call them.

**Two bugs came from forgetting this, and both were caught by RLS rather than by review:**

- `prisma.user.update()` for the last-login stamp ran outside `withTenant`. `users` is
  behind a policy that resolves through membership, so it found no row and threw *after*
  the password had already been accepted — a 500 on a correct sign-in.
- `uniqueSlug()` checked `select exists(... from organizations where slug = ...)` with no
  tenant context, so it always answered "free" and the second organization with the same
  name violated the unique index. Slug uniquing now happens inside
  `app_auth_bootstrap_org`, in the insert loop, which is also race-free.

The lesson both times: **if a query must run before a tenant is known, it belongs in
`rls.sql` as a narrow function — not in application code that quietly sees nothing.**

### The two planes

- **The curriculum plane carries no `organization_id`,** so its policy cannot be
  tenant-scoped and must not pretend to be: `for select using (true)`, plus **no insert,
  update or delete grant** for the app role at all. If a tenant could write subjects,
  "Mathematics" would be a different row in every organization and there would be no
  cross-tenant intelligence left to build.
- **`users` splits its policy by command, and that is not cosmetic.** Adding a student
  inserts a user row and *then* a membership; a single `FOR ALL` policy would evaluate
  the membership test on the INSERT, when no membership exists yet, and the insert would
  fail. So INSERT is `with check (true)` — a user row with no membership is invisible to
  every tenant and cannot become access without a membership row, and *that* insert is
  tenant-checked.
- **Postgres applies the SELECT policy to `INSERT ... RETURNING`.** Roster code therefore
  uses `createMany` with ids generated in the application and reads back only after the
  membership exists. A plain `create()` inserts the row and then fails reading it back.

### Curriculum

- **Two roles, not one.** `sahayak_app` has NO insert, update or delete grant on the
  curriculum tables and matches no write policy on them. Authoring runs as
  `sahayak_platform` over its own connection (`src/db/platform.ts`), and the write
  policies are scoped `TO` that role. A teacher-facing route physically cannot write
  curriculum — the role check in code is the second line of defence, not the only one.
  Neither role has BYPASSRLS, so tenant isolation is untouched.
- **A learning-outcome statement is prompt material, not a label.** With no seeded
  question bank to few-shot from, it is the only grounding a generator has. So
  `checkOutcomeStatement` requires a performable verb *in the opening words*: matching
  anywhere in the sentence passes "…and their many uses", where "uses" is a noun. It
  warns, never blocks, and the same function runs live in the editor and again on save,
  so the warning shown while typing is the verdict recorded.
- **Outcomes are authored, never seeded — and CBSE 9 and 10 now have them as
  DRAFTS.** Chapters are public record and seeded; outcomes are authored by
  someone who teaches the subject. Class 10 Maths chapter 6 is seeded as the
  worked example the editor is measured against, and a test asserts every one of
  its statements passes the check. Every other CBSE chapter's outcomes came from
  `prisma/curriculum-drafts/*.json` through `scripts/import-curriculum.ts` (see
  "The NCERT import") and are marked DRAFT for a subject teacher's review.
  Hindi has chapters (Class 9 Ganga; Class 10 Hindi A = Kshitij-2 then Kritika,
  Hindi B = Sparsh then Sanchayan, separate subjects because a student takes one
  course) but no outcomes: those need a Hindi teacher. The titles came from the
  NCERT project's reader-confirmed `title-overrides.json`. A course is two books
  and a chapter number is unique per subject, so the supplementary reader
  continues the numbering and names itself in the title.
- **`platform_admin` is a column on `users`, not a MemberRole.** MemberRoles describe
  someone inside one organization; this is the opposite. Granted only by
  `scripts/grant-platform-admin.mjs` over DIRECT_URL — there is deliberately no in-app
  way to promote an account. A non-admin gets 404 on `/admin`, never 403.

### Authoring concepts

- **This was the binding constraint on the whole product, not a missing screen.**
  Mastery is measured per CONCEPT and questions are filed against OUTCOMES, and
  until now nothing could create the link between them outside a seed file. So
  the console could describe a syllabus down to the outcome and still make none
  of it measurable: the seeded curriculum holds **two concepts covering five
  outcomes**. Since September 2026 the imported drafts add the rest — **197
  concepts over 472 outcomes** across CBSE 9 and 10 — so a real school can now
  be measured, and reported on, once a teacher has reviewed them.
- **There is no delete, and the reason is structural rather than cautious.**
  `concept_evidence.concept_id` and `student_concept_mastery.concept_id` are
  plain uuid columns with NO foreign key to `concepts` — deliberately, because a
  cross-plane constraint would couple the tenant tables to the shared one. So
  the database will not stop a delete: it would succeed silently and leave every
  estimate derived through that concept pointing at nothing. A concept is
  retired by unlinking its outcomes, which stops it accruing new evidence while
  leaving what it already measured explainable.
- **Unlinking is safe precisely because evidence carries its own
  `concept_id`.** Past rows keep their meaning and every historical estimate
  stays re-derivable; only future answers change. The editor says so on screen,
  because it is the question anybody hesitates over before pressing Unlink.
- **A prerequisite cycle is refused, and that check is the one that has to be
  right.** `prerequisitesOf` is walked to name a root cause; in a cycle every
  concept is the cause of itself, and the result is either a loop or advice that
  sends a teacher round in circles — the second being worse, because it looks
  like an answer. `wouldCycle` is pure and unit-tested, including a graph that
  already contains a cycle, because a pure function that hangs takes the server
  with it.
- **The slug is derived from the name and does NOT follow a rename.** It is an
  identifier: a seed file, a support ticket and anything anybody wrote down
  refer to it, and an identifier that changes when somebody fixes a typo is one
  nothing can rely on. Collisions resolve by suffix rather than refusing — two
  subjects legitimately teach "Ratio".
- **A duplicate NAME is refused outright.** Two concepts with the same name are
  indistinguishable on a heatmap column and in a report, and whichever one a
  question ends up mapped to is a coin toss.
- **A weight of zero is refused.** A link worth nothing makes the coverage
  figure claim an outcome is covered when nothing will ever be measured through
  it — a flattering denominator, which is the failure this whole screen exists
  to expose.
- **Only outcomes nothing else covers are offered for linking.** The same answer
  counting towards two concepts splits the evidence for both, and the weights
  that would make that honest are a judgement nobody can make from this screen.
- **The list is grouped by subject, and the first version was not.** It rendered
  every concept flat and ran to fifteen thousand pixels, findable only with the
  browser's own search. A console is not a dump. The "measures nothing yet"
  alert states a COUNT rather than listing names, for the same reason: with a
  hundred of them the alert was longer than the page it warned about.
- **Both truncated lists say they are truncated** — the same rule the audit view
  follows. Without it an author works through fifty rows, sees the list empty,
  and believes the job is done.
- **Concepts can be DRAFTED by a model and are only ever created by a person.**
  Authoring a full CBSE syllabus is several hundred concepts of judgement, which
  is the difference between a product that can ship and one that cannot.
  Grouping related outcome statements into the idea they share is what a model
  is good at and a person is slow at — so it proposes, and a platform admin
  approves. Same shape as question generation, and it matters more here: a
  concept changes what every school measures and there is no undo that does not
  orphan evidence.
- **The model works in INDEXES, never in ids.** A model asked to echo a uuid
  will eventually mistype one, and a mistyped uuid is a link to nothing that
  looks exactly like a link to something. Indexes are resolved against the list
  that was actually offered, and one out of range is dropped rather than
  clamped — clamping would silently attach the grouping to a different outcome.
- **Two gates, in that order.** The deterministic check runs before a person
  sees anything: a duplicate name, a name the pure checker rejects, an index
  that was not offered, or a grouping left empty after trimming are all
  discarded. A reviewer reading eight proposals of which three are malformed
  learns to skim, and a reviewer who skims is not a gate.
- **A discard is counted and reported.** If most of a batch is being dropped the
  prompt is wrong, and somebody has to be able to see that.
- **A thin grouping is FLAGGED, not hidden.** Sometimes one outcome really is
  its own idea — but a concept with one outcome behind it rarely reaches the
  evidence threshold, and will then sit on every screen saying "not enough
  evidence yet" forever. The reviewer decides.
- **An empty proposal list is a real answer.** Outcomes that share no idea are
  better left uncovered and visible than filed under a concept somebody has to
  unpick later: an uncovered outcome is a known hole, a wrong concept is a wrong
  measurement that looks right.
- **It refuses before it spends.** A subject with nothing uncovered never
  reaches the provider.
- **This is the one AI task in the product with no personal data in it at
  all** — learning-outcome statements from a public syllabus and nothing else.
  No student, no teacher, no organisation, not even a class name, and the ledger
  summary carries no identifier either. Stated as a claim somebody can check
  against the payload rather than assumed, and a smoke check greps the summary
  for anything uuid-shaped.
- **Not metered against any customer allowance.** This is platform curriculum
  work, done once by us, and every school benefits from the result. Charging a
  teacher's generation quota for our own authoring would be charging them
  twice — the same reasoning that keeps question validation off the meter.


### Assignments

- **There is no status column, and that is the design.** Whether an assignment is
  scheduled, open or closed is a function of two timestamps and the current time.
  Storing it would mean a cron flipping rows, and between ticks a row whose status is a
  lie — a student told a test is closed while the window is open, or worse the reverse.
  Derived at read time it cannot drift and needs no job. `cancelledAt` is stored
  because it is the one piece of state a clock cannot produce.
- **Same rule as the exam clock**: compute from stamps, never accumulate or cache.
- **Only a PUBLISHED assessment can be assigned.** A draft has no frozen question
  versions, so what a student saw could never be reconstructed afterwards.
- **A window shorter than the paper is refused**, measured against the duration
  override when there is one. Handing a class a test they cannot finish is the failure
  this catches.
- **No target rows means the whole class** — including anyone who joins tomorrow, with
  nobody having to remember to edit the assignment. Naming a subset requires students
  actually enrolled in that class.
- **`validateWindow` runs in the browser and on the server**, so a teacher never
  presses Assign and meets a refusal they could have been shown while typing.

### Attempts and the player

- **Null is not zero.** An unanswered question and an unmarked one both score `null`.
  Writing 0 there loses the difference between "they got it wrong" and "nobody has
  looked at it", and a student who wrote three paragraphs would be shown a zero for
  them. The rule runs all the way to the screen: the result page says *marked so far*
  and names how many marks are still with the teacher, rather than printing "0.0%".
- **A blank objective question is settled, not pending.** Both are unscored, but only
  one is waiting on a person. Counting a skipped MCQ as "awaiting marking" promises a
  student marks that are never coming.
- **The clock is derived from `startedAt + durationMs`, never counted down.** The
  client measures its offset from server time once and renders
  `expiresAt - (deviceNow + offset)`; the heartbeat re-measures it every thirty
  seconds. A phone that suspends the tab for forty minutes comes back correct, and a
  device with a wrong clock still sees the right number.
- **`clientAttemptId` is generated on the device before the request leaves it.** That
  is what makes a double tap on a flaky connection produce one sitting. A key minted
  server-side would be a new key every time, which is the bug it is meant to prevent.
- **Answers are ordered by `clientSeq`, last write wins.** A batch delayed by a
  reconnect is ignored rather than rejected — a student mid-exam is never blocked and
  never loses work, so "I already have something newer" is a normal outcome.
- **The autosave queue is written to localStorage BEFORE the request.** If the tab dies
  between the two, the answer is already on the device and goes up on the next load.
  Only what was actually sent is dropped from the queue, so anything typed mid-flight
  survives.
- **Offline is `navigator.onLine && the last request landed`.** School wifi reaches the
  router and nothing else, and the radio alone says that is online.
- **Submitting is idempotent and returns 200, not 409.** A retry gets the first result
  with `alreadySubmitted: true`. The client that retried did nothing wrong, and telling
  it otherwise leaves a student staring at an error page holding a finished paper.
- **`getPlayer` rebuilds options as `{key, text}` rather than filtering.** A field added
  to `Option` later cannot leak by being forgotten. There is a test that serialises the
  whole payload and greps it for `isCorrect`.
- **The sweep asks which tenants have work, then works one tenant at a time.** RLS shows
  a query exactly one organization, so a sweep written the obvious way finishes the
  first customer's papers and abandons everybody else's. `src/db/maintenance.ts` is the
  only module allowed to enumerate across tenants, and it returns ids — never rows.

### Plans and entitlements

- **No price is hard-coded anywhere**, including in `core/billing`. Every limit is an
  `entitlements` row reached through the active subscription; adding a plan, moving a
  limit or running a promotion is data.
- **A boolean capability is `unlimited: true`, never `limit_value: 1`.** Using 1 for
  both made "one class" and "analytics is on" indistinguishable in the data, and the
  settings page told a teacher on Free that classes were "Included".
- **A missing entitlement row means "not included", never "unlimited".** The failure
  modes are not symmetric: one is a support ticket, the other is a quarter of giving
  away the expensive thing.
- **A lapsed subscription gets the free shape, not the paid one.** The account keeps
  working; it does not keep what was paid for last quarter.
- **The gateway asks the plan BEFORE the budget.** "You have used your five
  generations" and "the organisation has hit a dollar ceiling" are different facts, and
  a teacher on Free should hear the first. `usage_counters` is the product promise;
  `ai_budgets` is our own safety limit — conflating them would let a price change move
  a safety control.
- **A use is counted only when the call worked.** A teacher whose five monthly
  generations were spent on provider timeouts has been charged for nothing.
- **Signup creates no subscription row.** The free fallback is explicit; putting a
  billing side effect on the signup path is putting it on a path that must not fail.

### The students index and settings

- **No overall score per student.** Averaging mastery across every concept gives a
  number that moves when the syllabus moves, invites ranking a class by it, and hides
  the thing that matters — which concept. The list carries band counts and the weakest
  concept BY NAME, because "struggling" sends a teacher to another page to find out
  with what.
- **Ordered by who needs you, not alphabetically**, and a student with nothing measured
  sorts above one who is fine: "we don't know about this person" is more actionable
  than "this person is doing well".
- **`/teacher/students` repeats the no-mobile warning.** A student without a number cannot
  sit anything, and discovering that on exam day is the failure this keeps catching.

### The platform console

- **`/admin` reads across tenants on the `sahayak_platform` connection**, bounded three
  ways: a separate connection the app never holds, `for select` policies only, and
  four tables (usage, generations, audit, organizations) that carry no student work.
  The alternative was a BYPASSRLS connection, which would hand a reporting problem
  every table in the database.
- **`organizations` had to join that list.** Without it every row on the cost
  dashboard read "Platform" — a console of uuids is not a console.
- **The audit view withholds `before` and `after`.** They can hold whatever changed,
  and answering "was that class deleted" does not need a student's phone number on
  screen.
- **A truncated list says it is truncated.** Exactly 200 rows during an incident is
  the difference between "it did not happen" and "I did not see it".

### Learning gaps

- **A gap is not a low score.** It is a concept below threshold *with enough evidence
  to say so*. A class that did badly on a paper nobody has finished marking is a
  marking backlog, and reteaching on that basis costs a lesson and a teacher's trust.
- **A gap closes on evidence and on nothing else** — never on age, never on somebody
  marking it done. There is no route that closes one; acknowledging says "I have seen
  this" and leaves it open. A dashboard whose gaps can be dismissed measures how tidy
  the teacher is.
- **PERSISTING is the most important status.** A gap that survived an intervention
  says the thing that was tried did not work, and it sorts to the top. Letting it look
  like a fresh DETECTED gap would lose the only signal that matters there.
- **Detection is a reconciliation, not an accumulation.** Running it twice on unchanged
  evidence changes nothing; running it after a class improves closes what improved,
  with nobody pressing anything. `detectedAt` is never re-stamped, so "how long has
  this been true" has an answer.
- **Severity averages the students who are behind, not the class.** Averaging in the
  ones who are fine makes a class with a few very weak students look like a class with
  a mild problem.
- **A root cause is only named when the class is weak on the prerequisite too.** A
  foundation they have already mastered is not why they are stuck, and naming it sends
  a teacher to reteach something the class can do — worse than saying nothing, because
  it costs a lesson and sounds confident.
- **Class-scope needs both a fraction and a floor.** Two of four is 50% and still two
  students; that is a conversation, not a lesson.

### Interventions

- **The baseline is stamped at creation and never updated.** This is the invariant the
  whole table exists for. Measured against current mastery instead, "improvement" is
  whatever the number happens to be when somebody looks — which always flatters the
  intervention, and an unfalsifiable improvement claim is what eventually loses the
  customer. `baselineMastery`, `baselineStudentCount` and `targetMastery` are written
  in the same transaction as the row, and nothing can change them afterwards. There is
  an integration test and a smoke check that move the mastery underneath a stamp and
  assert it did not follow.
- **A measured failure is worth more than an unmeasured success.** `measure` records
  whatever it finds; there is no path that abandons an intervention because the result
  was disappointing, and the gap goes to PERSISTING on the next detection pass. That is
  the signal the product exists to produce.
- **Measuring is a POST and works once.** A figure recomputed on every page load would
  show a different result each week as evidence accumulates. A second call is 409, no
  route un-measures one, and nothing accepts an outcome number from the caller — a
  measurement a teacher could type in is not a measurement.
- **One open intervention per gap.** With two running, whichever is measured second
  takes credit for both.
- **`targetFor` floors at the gap threshold, not at the baseline.** A target below the
  line that made this a gap would let an intervention "succeed" while the gap stays
  open. It caps at 0.95: 1.0 is a promise nobody can keep, and a target that can only
  ever be recorded as a failure teaches the teacher to stop recording them.
- **`measure` re-derives the mean over the students who are struggling now**, or over
  everyone measured if none is. Comparing a struggling-students baseline against a
  whole-class outcome would show improvement whenever the strugglers simply stopped
  being counted.
- **A remedial paper is calibrated down, and refuses rather than pad.** A group at 0.35
  gets nothing hard — a hard question there measures what is already known and costs a
  student who is behind the confidence to keep going. And if the bank holds three
  approved questions on the concept, it says so with the number instead of reaching for
  a neighbouring concept: the sitting exists to give one clean second reading, and a
  paper half about something else cannot.
- **The remedial paper is assigned to the students below the line, not the class**, and
  the targets are recomputed at build time — a student who has caught up since the gap
  was found is not made to sit it.
- **Its duration comes from `expectedTimeSeconds` (or 90 seconds a mark), times 1.5.**
  A flat ten minutes a question turned eight one-mark MCQs into an eighty-minute exam,
  which a screenshot caught and no test would have. Generous, because what is being
  measured is whether they can do it — not whether they can do it quickly.
- **`planRemedial` and `buildRemedial` share one path**, so the preview cannot disagree
  with the outcome. Same rule as the roster importer.

### The Mistake Bank

- **A mistake is a SETTLED wrong answer.** An unmarked written answer is not a
  mistake, it is unmarked — putting a student's own three paragraphs in front of
  them under "you got this wrong" before anybody has read them is the worst thing
  this feature could do. Objective answers settle at submission (a blank
  included); written ones settle when `awardMarks` runs, which re-runs the
  recorder.
- **Full marks on a re-mark deletes the row.** A teacher who looks again and
  raises 1 of 3 to 3 of 3 must not leave a stale card in the student's bank; the
  product does not argue with the marker.
- **It resolves on independent evidence and nothing else.** Getting the SAME
  question right again is `RETRIED` — engagement, not proof, because you have
  seen the answer. `RESOLVED` needs a *different* question on the same concept,
  answered correctly, after the mistake — which `concept_evidence` already
  records, so it costs one reconciliation query and no new bookkeeping. There is
  no route that closes one, exactly as with a gap. The screen says all of this
  out loud so nobody is surprised their correct retry is still on the list.
- **Full marks only for the proof.** A 2-of-3 on the concept is progress, not
  evidence the mistake is fixed — the same refusal the marking layer makes.
- **The explanation and the key are withheld until they retry**, and absent from
  the payload rather than hidden by CSS. A bank that opens with the answer
  showing is a reading exercise.
- **Advice has to work in the order the page happens.** The CONCEPTUAL line used
  to say "go back to the explanation before trying again" — advice the screen
  cannot obey, since the explanation is behind the retry, and it contradicted the
  only control on the page. A screenshot caught it; a unit test now pins it.
- **Rules first, and that is the cost model.** Classification runs once per wrong
  answer, which makes it the largest AI line by call count. A blank, a paper that
  timed out, and a rushed answer on a concept the student can demonstrably do are
  all typed by rule, free and certain. Only the ambiguous remainder goes to a
  FAST-tier model, nightly and in batches of 20 — never on submission, because
  nothing here needs a type within the second.
- **A wrong true/false is settled by rule as "no clear reason".** Two options
  means getting it wrong is one bit, and one bit cannot separate "does not
  understand" from "guessed". A model asked can only invent, and it must not
  re-queue every night to be told UNSURE at a cost. `classified` and `examined`
  are therefore different fields: "looked at, nothing to say" is a finding, and
  showing it as "not looked at yet" would promise an answer that is never coming.
- **CARELESS needs corroboration, not just speed.** A student who does not know
  something also answers quickly. Speed alone would tell somebody who is stuck
  that they were merely sloppy — the one error here that actively misleads — so
  the rule needs mastery above the threshold AND a single visit AND an author's
  expected time to measure against.
- **The list is headed by the QUESTION, not the concept.** Three cards all headed
  "Similarity of triangles" tell a student nothing about which is which, and the
  concept is already in the sentence at the top of the page.
- **`/student/mistakes` is reached from Home and from a result, never from the standing
  navigation.** A permanent link labelled with your own failures is one a
  fifteen-year-old learns to skip. The page is called "Things to fix".
- **The bank is outside a parent's read scope** (SECURITY_MODEL.md), and no route
  takes a student id — `?studentId=` would be the first crack in that.

### Personalised practice

- **Practice IS evidence, at a reduced weight.** The safe-looking choice was to
  exclude it, and it fails the product's own North Star: `PRACTICE_SET` is an
  intervention kind, and an intervention whose effect can never reach the mastery
  figure can never be measured as having worked. But it cannot count the same as
  a supervised paper either — untimed, unwatched, with the explanation a tap
  away, at full weight it makes mastery a function of persistence, and a gap that
  closed because somebody ground questions at home is a lesson not taught.
  `PRACTICE_WEIGHT = 0.4` multiplies the concept-mapping weight, so roughly five
  practice answers carry what two exam answers do.
- **`concept_evidence.source` is what makes 0.4 reversible.** The number is a
  judgement and will be wrong at first. Because every row is stamped ASSESSMENT
  or PRACTICE, `rebuildMastery` re-derives every estimate in the system when it
  changes. That is the whole reason the ledger is separate from the estimate.
- **Evidence lands when the set is finished, never per answer.** Per-answer
  writes would let a student watch their own estimate move as they worked, which
  turns practice into a slot machine — and an abandoned set contributes nothing,
  because crediting the four they did before closing the tab rewards starting
  over finishing.
- **Feedback after every question is the entire difference from a test.** No
  clock, no navigator, no submit. The explanation arrives while the student's own
  reasoning is still in their head, which is the one moment it can change
  anything. The answer is revealed per question — answering the third must not
  unseal the rest — and is absent from the payload until then.
- **Answering the same question twice is refused.** A set a student could walk
  until every verdict was green would make practice evidence worthless.
- **A question just answered correctly is not served again for 30 days.**
  Repeating what you can already do is the least useful minute in revision, and
  it is also what would let somebody grind four questions until the estimate said
  whatever they wanted. A question they got WRONG comes back immediately.
- **Machine-markable only.** A written answer needs a person and there is nobody
  waiting; serving one would either promise feedback that never arrives or grade
  prose with a string comparison.
- **`recommend` is pure and every candidate carries its sentence.** The
  rationale is built from the numbers that produced it — "you are getting about
  30% of these right", not "you are weak at this". A recommendation a student
  cannot interrogate is one they stop trusting the first time it is wrong.
- **It refuses.** Nothing measured means no recommendation, not a default — the
  fifth application of the pattern. And three refusals, not one: "sit a test",
  "your teacher can add some questions", and "nothing needs work" are different
  instructions and must never share a sentence.
- **A concept is never offered twice on one page.** One card per concept under
  its strongest reason, and a concept with a set already open appears only as
  "carry on" — both routes resume the same session, so two cards is the page
  arguing with itself.
- **Practice can close a mistake, deliberately.** The bank's rule has always been
  "a different question on the same idea, right", and practice satisfies it. The
  alternative — resolution only from a test — means a student can never clear
  their own bank by their own effort, because they cannot set themselves a paper.
- **After answering, the option itself carries the verdict.** Leaving the tapped
  option in the accent colour reads as approval directly above the words "not
  this time"; a screenshot caught it. The right one is marked CORRECT and theirs
  YOU CHOSE THIS, so colour is never alone.

### The parent portal

- **Access is the link, never the role.** A PARENT membership grants nothing —
  the authorize matrix gives it `profile:read_own` and stops. Everything a parent
  can see comes from a `ParentStudentLink` with consent granted and no
  revocation, re-derived on every read. "Is a parent" and "may read this child"
  are different questions and only the second is ever asked.
- **The scope boundary is a fence, not a sentence.** `core/parent/read.ts` is the
  only module the parent surface may read student data through, and an ESLint
  block over `src/app/parent/**` and `src/app/api/parent/**` rejects `@/core/mistakes`,
  `@/core/practice`, `@/core/attempts`, `@/core/results`, `@/core/analytics`,
  `@/core/gaps` and every `@/db/*` path including `@/db/tenant`. A rule left as a
  sentence in a document survives about two features. That block RESTATES the
  database paths — flat config merges last-wins, so it replaces rather than adds.
- **Nothing returns a free-text answer, and there is no argument that could make
  it.** The attempts query in `childView` selects scores and never `answers`. An
  integration test and a smoke check serialise the whole response and grep it for
  a string the child typed.
- **Consent is stamped to the person who gave it**, not the teacher who asked.
  The teacher sends the link; the parent holding the phone agrees, and that
  distinction is the whole of what "explicit recorded consent" means when
  somebody asks a year later.
- **Revocation is a stamp, never a delete.** "Who could see this child's results,
  and until when" is asked after something has gone wrong, and a deleted row
  cannot answer it.
- **An unaccepted invitation grants nothing**, which is what makes it safe to SMS
  to a number a teacher typed. But the teacher must still SEE it — `linksForStudent`
  returns pending invitations with the number masked, because a teacher who sees
  an empty list sends a second link.
- **`app_auth_invitation` is the fifth pre-tenant read.** An invitation is opened
  by somebody with no session, which is sign-in's ordering problem again, answered
  the same way: exact token hash in, one narrow row out, nothing about the child's
  work in it. `app_auth_verify_code` is a sixth, and exists because
  `app_auth_consume_code` returns nothing when no user exists — right for a
  student who is on a roster before they sign in, wrong for a parent who has no
  account until they accept.
- **A parent's release gate is the student's release gate**, through the same
  `resultsVisible()`. A parent seeing a mark before their child does turns a
  result into an ambush. That function now exists because writing the rule a
  third time was not an option — it was already duplicated twice inside
  `student-view.ts`.
- **A concept never appears under both "going well" and "needs help".** With one
  measured concept it was listed as both the strongest and the weakest, badge and
  all. A screenshot caught it; a test pins it.
- **`/parent/link/[token]` must stay unauthenticated**, so the portal lives in a
  `(portal)` route group with the guard and the invitation page sits outside it.
  A guard on `/parent/layout.tsx` would lock out exactly the people it is for.

### The institute console

- **There is no teacher league table, and that is the considered half of the
  feature.** PRODUCT_REQUIREMENTS.md asks for "teacher activity and outcomes";
  `teacherActivity()` returns the first and refuses the second. Ranking teachers
  by their students' mastery is confounded before it is unfair: a teacher handed
  the bottom set scores lower however well they teach, and *which students you
  were given* dwarfs everything this product can observe. Worse, once teachers
  know they are ranked on it, avoiding the students who need them most becomes
  the rational move — the opposite of what the product is for. Every column is
  something the teacher controls this week. A test greps the serialised rows for
  `mastery|estimate|score|percentage|rank` and fails if one appears.
- **If teacher effectiveness is ever measured, the only defensible shape is the
  one `core/gaps/interventions.ts` already uses** — improvement against a
  baseline stamped before the teaching, on the same cohort.
- **Exceptions come before counts.** An owner does not need to be told they have
  twelve teachers; they need to be told which two have papers unmarked a
  fortnight after the test. Every exception names a number and links to where it
  is fixed — one that cannot be acted on gets ignored, and then so do the others.
- **A brand-new class is not a quiet class.** The untested check only considers
  classes that have existed longer than the window; "Class 10-B has had nothing
  set for 30 days" about a class created on Tuesday is false, and an owner who
  reads one false line stops believing the list. A screenshot caught it.
- **`activeStudents` counts distinct people, not sittings.** Six papers from one
  keen student is not six active students, and that figure gets quoted in a
  renewal meeting.
- **An organization always keeps one owner.** Demoting or removing the last one
  is refused at every route: no owner means nobody who can manage billing, invite
  anybody, or undo it, and no route back except database access. You also cannot
  change your own role — that is how somebody locks themselves out by accident.
- **Only an owner may create another owner.** An admin who could promote to owner
  could promote themselves, which makes the two roles decorative.
- **Removal is `SUSPENDED`, never a delete**, and it deletes their sessions. The
  membership row survives because their papers, their marking and their audit
  rows all point at them; the sessions do not, because removed-and-still-signed-in
  is not removed.
- **The console is gated by the PLAN as well as the role**, through
  `can(organizationId, "admin_console")` — so which plans include it is data, and
  there is no plan code in the layout. A teacher is redirected; an organization
  without the entitlement gets 404, not a 403 and not an upsell. A solo teacher
  on Free is not a failed institute.
- **Batch means carry their denominators and refuse below `MIN_MEASURED`** — the
  same constant `core/analytics/class.ts` uses, imported rather than repeated,
  because two screens disagreeing about when a number exists is worse than either
  rule alone. "10-A is at 71%" over four measured students of thirty describes
  nothing.
- **The batch mean averages per student, then across students** — not a flat mean
  over mastery rows. Averaging rows lets one keen student with thirty measured
  concepts count seven times as much as one with four, so the class figure would
  move when they sat another paper.

### The AI Teacher Copilot

- **The provider never sees a student's name.** Students reach the model as
  `STU_a41f0c` handles built by `opaqueId()`, and the answer is re-hydrated in
  `core/copilot/index.ts` from a map that never left the process. The result is a
  Copilot that says "Meera and two others are behind on ratio" while Anthropic
  was told about three handles. The brief's rule — *never send unnecessary
  personal information to AI providers* — implemented rather than promised, and
  it costs nothing. A test asserts the name is in the answer AND absent from
  everything the mock received.
- **Handles are stable**, because `opaqueId` is a pure hash of the id. A
  follow-up question only works if the same student is the same handle.
- **Re-hydrate before storing, not at render.** An answer full of handles is one
  a teacher cannot read a week later, and re-hydrating on read would mean
  carrying the identity map forever.
- **There is no tool-calling, deliberately.** A model that could query would need
  a query surface, and a query surface reachable by a prompt is a tenancy
  boundary defended by English. Everything the Copilot can see is assembled first
  inside `withTenant` and handed over as a fixed block.
- **Every null the product decided on arrives as "not enough evidence"**, not as
  a missing key. A missing key is an invitation to guess, and a model handed
  thirty concepts with four numbers will average the four. Every mastery line
  carries `N measured of M students` for the same reason.
- **It refuses before the call, twice.** The plan is checked first — a teacher on
  Free is told their plan is the problem, not their data, the same
  plan-before-budget ordering the gateway uses. Then emptiness: nothing measured
  means no call at all, because paying DEEP-tier rates to be told there is
  nothing to look at is the worst outcome available.
- **`empty` means nothing MEASURED, not nothing set.** A teacher with a paper out
  and no marking has nothing to reason over, and answering "you have one open
  test" at DEEP rates is the most expensive way to say something they can
  already see.
- **Metered on `copilot_questions_per_month`, its own key.** A question must not
  eat the generation allowance a teacher bought to write papers with — two
  different promises, and conflating them means somebody who asked five questions
  cannot set a test. Free has no row at all: a missing entitlement is "not
  included", never "unlimited".
- **The teacher's question never reaches `ai_generations.input_summary`.** It goes
  to the provider — it has to, it is the question — but the ledger row is read by
  a platform admin during an incident and has no business holding a teacher's
  sentence about a named child. Only its length is recorded.
- **Every answer carries the figures it used.** A teacher acting across a whole
  cohort has to be able to find the row it came from; otherwise it is an
  assertion with a robot's confidence.
- **A conversation belongs to one teacher**, scoped to their user id on top of
  the tenant policy. A colleague gets the same 404 as a stranger.
- **It is kept, and that is a cost control.** A question asked on Friday is one a
  teacher wants the answer to again on Monday, and re-asking costs a DEEP-tier
  call — roughly forty times a classification.

### Rubrics

- **The criteria must sum to the question's marks.** A scheme adding to 5 on a
  six-mark question cannot award full marks to a perfect answer, and nobody
  discovers that until the twentieth paper — by which point every mark given is
  wrong and re-marking is the only fix. An ERROR at save, never a warning.
- **The total is derived, never typed.** `awardByRubric` has no parameter for
  it. A marker who can set both the criteria and the total can disagree with
  themselves, and the student is then shown a breakdown that does not add up to
  their mark.
- **Every criterion or none.** A partly filled scheme produces a total that
  looks like a judgement and is an omission.
- **A mark above a criterion's value is refused, never clamped** — the same rule
  the total box already followed.
- **Marks go in halves.** 1.5 is real in CBSE marking; 1.33 produces totals that
  do not add up on paper.
- **The rubric lives on the VERSION, beside the answer key.** An approved
  question is immutable and the mark scheme is part of what was approved, so a
  paper marked in August is still explainable in December. Editing it creates
  version n+1.
- **No rubric is an ordinary state** and stays supported. A scheme is an
  improvement on typing a number, never a gate in front of it — and every
  question authored before this existed has none.
- **`awardByRubric` delegates to `awardMarks`** rather than repeating it. The
  partial-credit rule, the re-score and the four downstream hooks (evidence,
  gaps, mistakes, resolution) exist once; a second copy is a second copy that
  drifts.
- **The breakdown reaches the student behind `reviewable`**, with everything
  else. It is a stronger disclosure than a total, and a class sitting in two
  sessions must not have the first holding the mark scheme.

### Adaptive practice

- **A set is served one question at a time**, each chosen from how the set has
  actually gone. Only the first is materialised at start; the rest arrive with
  the verdict on the previous one, so the runner needs no second round trip
  between questions.
- **Two consecutive answers move the level, not one.** Stepping on a single
  answer makes the set sawtooth — right, harder, wrong, easier — and a student
  gets oscillation instead of a direction.
- **It steps down faster than it steps up.** Deliberately asymmetric: there is
  no floor below EASY, but the ceiling is the level the set opened at plus one.
  A run they cannot do is how somebody decides they are bad at the subject and
  closes the tab; and a student put on EASY because they are at 0.3 has not
  earned HARD by getting two easy questions right.
- **`baseDifficulty` is stamped at start, never re-derived.** Practice writes
  evidence, so a re-derived base would drift upward mid-session and take the
  ceiling with it. Same reasoning as an intervention's baseline.
- **`pickNearest` breaks ties downward.** Serving a harder question than asked
  for, because the bank happened to be short, is the one direction this must not
  drift in.
- **When the bank runs out the set ends and the score is over what they
  actually did** — not over a number the set promised and could not deliver.

### The study plan

- **A plan is an ORDER, never a timetable.** No dates, no durations, no
  "Monday: 30 minutes of trigonometry". It is a promise about somebody else's
  evening that this product cannot keep — it does not know about the wedding on
  Saturday or the tuition already booked — it is wrong by Tuesday, and a plan
  that is already behind is one a student closes rather than catches up on. A
  unit test greps every item for clock times, durations and weekdays.
- **It is derived at read time and stored nowhere.** Same rule as an
  assignment's status: a stored plan is stale the moment the student practises,
  and keeping it fresh would need a job with rows that are a lie between ticks.
  A smoke check asserts no `study_plan` table exists and that no route can tick
  an item off.
- **An item leaves when the evidence moves, and on nothing else.** There are no
  checkboxes. A plan you can tick off measures how tidy you are — the same claim
  a learning gap and a mistake already make, applied to the list that tells a
  student what to do. The page says so out loud, because a student who does the
  work and comes back to the same list otherwise concludes the page did not
  notice.
- **It never reads what a paper is about.** The concepts a coming test covers
  are derivable — the paper is frozen at publish and the two-hop from questions
  to concepts already exists — and using them would be the wrong feature.
  Telling a student the concept mix of a paper they have not sat narrows their
  revision on the teacher's behalf, and the teacher chose the paper. So the
  plan pairs what the student can already see (a Maths test on Thursday) with
  what the product knows about THEM (which Maths concept they are weakest on).
  Just as useful, and it gives nothing away.
- **Deadlines are not capped; discretionary items are.** A student with seven
  papers open has a seven-item plan, and padding it with practice would be the
  product competing with their teacher for the same evening. `MAX_ITEMS = 5`
  bites only on the half nobody else decided.
- **A secure concept never appears.** "Solid — here if you want to keep it that
  way" is an offer, and it belongs on the practice page where it can be ignored
  without ignoring the plan.
- **It reuses `recommend` rather than re-deriving.** Two functions that both
  decide what a student is weak at will disagree eventually, and a plan
  contradicting the practice page on the same screen is worse than either being
  wrong alone. `studentConceptStates` was extracted from `recommendations` for
  exactly this — one parser, two callers, as with the roster.
- **Home shows ONE prompt, not three.** It used to carry a practice nudge and a
  mistakes nudge above the test cards; the plan contains both, in an order it
  decided, and the papers are already listed below with their windows. So Home
  shows the plan's best NON-deadline item and links to the rest — a nudge whose
  top item was a paper would be the page saying the same thing twice.
- **The rank is drawn, and top-aligned.** This is the one list in the product
  where order carries information, so the number is a real element rather than a
  browser marker. Centred, it floated beside the middle of a three-line item and
  stopped reading as the number *of* that item; a screenshot caught it.

### Reports

- **A report is STAMPED, and the study plan is DERIVED — the difference is the
  artefact.** A plan must be current, so storing it makes it a lie. A report is
  handed to somebody: a parent shown "3 of 9 ideas measured" at a September
  meeting must be able to bring that sheet in December and have it still say
  that. A report regenerated on read would change silently under a
  conversation. So the payload is written once, in the transaction that creates
  the row, and nothing updates it — the same invariant as an intervention's
  baseline, and an integration test moves the mastery underneath a written
  report and asserts it did not follow.
- **Regenerating SUPERSEDES; nothing is edited or deleted.** There is no PATCH
  and no DELETE. Both rows survive, the older is marked superseded on the list
  and on the sheet itself, and it stays readable — "what did we tell this parent
  in September" is a question somebody asks.
- **There is no overall grade, and a report is where the pressure to add one is
  strongest**, because a report looks like a report card. It carries band
  counts, named concepts and every denominator. Averaging across concepts gives
  a figure that moves when the syllabus moves and invites ranking children.
- **Coverage is the headline, above the marks.** "Secure on 2 of 5 measured" and
  "secure on 2 of the 40 ideas in the syllabus" are different statements about a
  child and only one is true. `conceptsForSubjects()` supplies the real
  denominator; without it a report can only count what it already measured,
  which is the definition of a flattering denominator.
- **Below three measured concepts it refuses to exist.** A thin report is worse
  than none: it is a document, with a date on it, that somebody will act on. In
  a class run the refusals are NAMED per student — a teacher who gets 26 of 30
  needs to know which four before one of those four's parents asks.
- **The opening estimate is what the evidence ledger was built for.** Improvement
  over a term runs the same pure estimator over the same `concept_evidence`
  rows, filtered to what was known on the day the period opened. No history
  table, and the two-table split's stated promise — every past estimate is
  re-derivable — finally used rather than asserted.
- **Improvement is claimed only where BOTH readings exist.** "Improved from
  nothing" is a first measurement, and calling it progress is the most
  flattering lie this document could tell. Movement under 0.1 is noise. Falls
  are reported as readily as rises.
- **No AI anywhere in a report.** A model would phrase the summary more warmly
  and would occasionally phrase it wrongly, and a warmly-worded wrong sentence
  about somebody's child, on a paper they keep, is the worst output this product
  could produce. Every sentence is assembled from the figures.
- **One row per PAPER, not per attempt, showing their best.** Four attempts at
  one paper printed four rows with the same title and date, which reads as a
  fault in the product and overstates how much testing happened. Best rather
  than last, because attempts exist so a student can improve and reporting the
  final go would punish trying again. A screenshot caught it.
- **The print stylesheet IS the download.** PRODUCT_REQUIREMENTS.md asks for a
  downloadable term report; a browser's Save-as-PDF produces one on every
  device including a parent's phone, respects their font size, and needs no
  server dependency. So `report.css`'s `@media print` block is a feature, not
  polish: fills become rules so a needs-attention row survives a black-and-white
  printer, and `break-inside: avoid` keeps a section off two pages.
- **Two print bugs, both found by photographing the print view.** The hide list
  invented `.ui-app-nav` and `.ui-topbar`-adjacent names that did not exist, so
  the whole navigation rail printed down the left of the document; and a bare
  `footer` selector removed the sheet's own closing caveat, which is the one
  line that has to travel with a document that leaves the building.
- **`payloadVersion` is stamped, and the renderer checks it.** A stored document
  outlives the code that wrote it. An unknown version renders as a plain
  statement rather than a half-drawn sheet with fields missing.
- **A parent reads reports through `core/parent/read.ts` and nowhere else**, and
  the ESLint fence now rejects `@/core/reports` from `src/app/parent/**` too:
  `core/reports` takes a student id and checks no consent at all. The consent
  check runs on the child the report is ABOUT, resolved from the row — a report
  id is not a capability.
- **`payload` is jsonb, so key order is not preserved.** Two identical documents
  serialise differently; nothing may compare them as strings.
- **Three measured concepts are required**, and until the NCERT drafts were
  imported the seeded curriculum held two in total, so no school could be
  handed a report. Both the integration suite and the smoke script still author
  their own concepts — inside a fixture chapter, removed after the run — so the
  path is exercised independently of whatever the real curriculum holds.

### The student tutor

- **The guard is the feature, not the prompt.** The model is told never to state
  the answer AND every reply is checked against the stored key before a student
  sees a word of it — `core/tutor/guard.ts`, pure and deterministic. A rule the
  prompt states is a rule the model follows most of the time, and "most of the
  time" is not a property you can build a feature on. A tutor that answers the
  question is a homework machine: popular, excellent usage numbers, and every
  student using it learns less than one without it.
- **The model IS given the answer key**, which looks backwards and is not. The
  alternative fails on the first question: AI_ARCHITECTURE.md's opening
  principle is that a tutor explanation may not contradict the stored key, and a
  hint pointing confidently the wrong way is worse than no hint — the student
  follows it, gets it wrong twice, and stops trusting the feature.
- **A leak falls back to the AUTHORED hint, and stamps `wasWithheld`.** Falling
  back beats refusing: a student who asked for help and got an error does not
  ask again. Counted rather than hidden, because if it is not rare then the
  prompt is wrong and somebody has to be able to see that.
- **`namesTheKey` needed the linking verbs.** The first version required the key
  to follow the noun directly — "option B", "answer: B" — and therefore missed
  **"The answer is B"**, which is the single likeliest sentence a model would
  write if it were going to leak at all. A unit test caught it before anything
  shipped, which is the whole argument for the file existing.
- **Three named rungs, never one "Help" button.** Hint, then method, then the
  idea said another way, each button naming what the student is agreeing to see.
  One button would let somebody who wanted a nudge land on a full walkthrough —
  and having seen it, they cannot go back to not having seen it.
- **The level is the server's decision; the route has no `level` parameter.** A
  client that could ask for EXPLAIN first could skip the hint, which is the
  whole ladder, and would make `maxLevel` unfalsifiable.
- **Asked again at the top, the last turn comes back — no fourth call.** A
  fourth phrasing of the same idea at a fourth cost helps nobody.
- **A practice answer given after help produces NO evidence — not less.**
  Mastery is a claim about what a student can do alone, and an answer they were
  walked through says nothing about that. A reduced weight would be worse than
  zero: a number that is slightly wrong is harder to notice than one that is
  absent, and this one ends up in front of a teacher deciding whether to
  reteach. The timestamp matters — asking from the review screen AFTER answering
  does not retrospectively void work already done unaided.
- **And the student is told that, before they press.** The rule applies whether
  or not they are told, so not telling them would only mean discovering it from
  a progress figure that did not move — which reads as a bug, or as a punishment
  nobody mentioned.
- **A per-student daily cap sits on top of the per-organization entitlement.**
  The plan is priced per teacher and metered per school; without the cap, one
  student can spend a 200-student school's month in an afternoon and everybody
  else meets a wall they did nothing to cause. Same distinction the gateway
  already draws between the plan and the budget.
- **Free has no `tutor_hints_per_month` row at all**, and for the opposite
  reason to the Copilot's: this one is cheap per call and metered per student,
  so on a free plan its cost scales with the users who pay nothing.
- **Tutor conversations are outside the parent scope**, enforced by the ESLint
  fence over `src/app/parent/**` rather than by a sentence in a document. A child who
  believes a parent reads every time they asked for help stops asking.
- **The panel sits UNDER the retry, never above it.** Help offered before the
  attempt is help taken instead of the attempt.
- **`--text-tertiary` WAS documented as 14px-and-up only, and that rule is now
  retired.** The help panel's 12px label and 13px blurb were built with it and
  moved to `--text-secondary`; a screenshot caught it, no test would have. But
  the restriction was only ever a mitigation for the old `#6e7787`, which failed
  AA on the real surfaces — and that token has since been replaced by `#5f6877`,
  measured at 4.92:1 on the darkest surface it is used on and 4.57:1 in dark
  mode, which passes AA at any size. `DESIGN_SYSTEM.md` went on asserting the old
  hex, the old wrong-background ratio and the dead restriction for months
  afterwards, and it eventually produced a **false** bug report against three
  shared classes that were fine. A stale rule does not merely fail to help; it
  spends somebody's afternoon.

### Exam readiness

- **There is no readiness percentage, and the refusal to add one is the
  feature.** It would be the composite score this product refuses everywhere
  else — no overall score per student, no single class mastery score, no overall
  grade on a report — except printed in front of an anxious fifteen-year-old
  before boards, where it does the most harm and moves whenever the syllabus
  moves. Readiness is a picture: coverage first, then band COUNTS, then the
  chapters nobody has tested, named.
- **The refusal is structural, not a rule.** The `ok: false` arm of `Readiness`
  has no `standing` field at all, so nothing can print "2 secure" above "3 of 51
  chapters measured". Same trick as `Mastery`'s missing `estimate`, and a second
  one below it: `MeasuredConcept` narrows `band` to the four real bands and
  `estimate` to `number`, so a component cannot render a figure the estimator
  refused.
- **Two bars, and both must clear**: five measured concepts AND half the
  chapters. Five concepts all inside one chapter is a statement about that
  chapter. Fraction plus floor, the same shape class-scope gap detection uses.
- **"Tested" is read from the PAPERS, not from the evidence ledger.** Almost
  every seeded outcome has no concept mapped, so a ledger-derived answer would
  call a chapter untested immediately after a student sat a whole paper on it.
  One visibly false line and a fifteen-year-old stops reading the page. It also
  produces a genuine third state — `thin`, meaning asked about but not enough to
  say yet — which the page names rather than rounding to one of the other two.
- **Derived at read time, stored nowhere**, for the study plan's reason: a
  readiness stored is a readiness stale, and the only thing worse than no
  picture is one that was true a month ago.
- **It refuses until enough has been SAT, and that is honest rather than
  degraded.** Before the NCERT drafts, concepts covered one of the fourteen
  Class 10 Maths chapters and the chapter bar could not be met by anybody. Now
  every CBSE chapter except Hindi has concepts, so the bar is about how much a
  student has actually been tested on — which is what it was always meant to
  be about. "We have measured 3 of the 51 chapters in your syllabus. That is
  not enough to tell you whether you are ready" is still the right answer
  after three.

### Institute analytics

- **The most valuable thing here is `conceptSpread`, and its verdict is the
  point.** A concept weak in two or more classes is `systemic` — the material or
  the order it is taught in — and a concept weak in one is `localised`. Those
  need different people to do different things, and an owner who is handed one
  undifferentiated list of weak concepts does neither.
- **A class below `MIN_MEASURED` is neither weak nor fine. It is unknown.**
  Counting it as either would be the page's most confident wrong finding, and
  the one most likely to send somebody into a classroom that did not need them.
- **`meanAcrossClasses` gives each class one vote**, exactly as the batch mean
  gives each student one. Averaging cells would let the biggest class decide what
  the institute thinks.
- **Improvement is claimed ONLY against `Intervention.baselineMastery`**, the
  figure stamped before the teaching. It is the one defensible shape, it is
  already implemented in `core/gaps/interventions.ts`, and re-deriving a baseline
  here would produce an improvement number that flatters whoever asks. Below
  three measured outcomes the institute-wide aggregate refuses; individual
  measurements are listed worst first, because a measured failure is the signal.
- **Still no teacher league table, and the new module does not read a teacher
  anywhere.** Not `class_teachers`, not `memberships`, not a user row. A test
  asserts the real teacher's id AND full name are absent from the serialised
  payload, on top of the existing grep for `mastery|estimate|score|percentage|rank`.
- **`conceptsAcrossBatches` lost every student enrolled in two classes.** The
  student→class lookup was `new Map(enrolments.map(...))`, which keeps only the
  last entry per key, so somebody in 10-A and the Maths set reached exactly one
  grid and the other room under-counted its own `measured`. The mean it then
  printed was arithmetically correct over a denominator quietly missing people —
  precisely what `MIN_MEASURED` exists to prevent, defeated one layer below it.
  They count in both rooms now, because they are in both rooms.

### Internationalisation

- **The seam translates the interface, not the curriculum, and that has to be
  said out loud.** Questions, options, explanations, chapter names and outcome
  statements are authored by teachers in English, live on the shared curriculum
  plane which has no locale column, and are frozen by version at publish. A
  student who switches to Hindi gets a Hindi interface and English questions.
  A Hindi question bank is an authoring project, not an infrastructure one.
- **Precedence is stored preference, then `Accept-Language`, then `en-IN`.** The
  stored value outranks the header because a large share of students sign in on a
  phone that is not theirs: the header describes whoever set the handset up and
  does not change when a different person signs in, so a header that won would
  silently undo a student's own choice at every sign-in.
- **A missing key is a COMPILE error.** `MessageKey` is derived from the English
  catalog and the placeholder names are extracted from each message by
  template-literal types. The alternative fails silently in the worst place: a
  missing string renders as an empty element, in a language nobody on the team
  reads, and a user who cannot read the button does not file a bug.
- **Plurals go through `Intl.PluralRules`, never `count === 1`.** CLDR puts zero
  in **Hindi's `one` category** and English's `other`, so the naive check is
  wrong for every empty list in the Hindi build — and empty is the commonest
  count a list has.
- **The time zone is pinned to `Asia/Kolkata`**, which is correctness rather than
  preference: a server on UTC renders a 00:30 IST deadline as the previous day
  while the teacher's own browser renders the next one.
- **`User.locale` still cannot be read, and that is a seam change rather than a
  cleanup.** `app_auth_resolve_session` does not select `u.locale`, and it is one
  of the narrow pre-tenant SECURITY DEFINER reads whose column list is
  deliberately fixed. Making the stored preference win means changing `rls.sql`,
  `unscoped.ts` and `context.ts` together. Until then the header rung answers,
  which on the sign-in page is the only rung that could — there is no session yet.

### Webhooks and the outbox

- **Events are written in the SAME TRANSACTION as the thing that happened.**
  That is the entire reason an outbox exists rather than an HTTP call at the call
  site: an event that was delivered is then necessarily an event that occurred,
  and one that occurred is necessarily queued. A direct call gets both halves
  wrong under a rollback.
- **Emission is a database trigger, not application code**, and the accident is
  better than the plan. The guarantee then holds for every path that changes the
  row — a backfill, a support fix over psql, the next feature — rather than for
  the call sites somebody remembered. Each trigger body sits in a subtransaction
  with `exception when others then raise warning`, so the emit path cannot fail a
  teacher's publish. They are NOT `security definer`: the outbox insert is
  checked against the tenant policy like any other write.
- **`results.released` fires at RELEASE, never at submission.** Firing at
  submission would route an integration around `resultsVisible()` — the gate that
  stops a parent, or a school's own MIS, holding a mark before the child does.
- **The payload carries ids and figures, never contact details and never a
  student's own words.** An allow-list `select`, not a deny-list, for the reason
  the AI scrubber uses one. An MIS already knows its own students; it does not
  need a phone number from us.
- **`marksAwaitingMarking` and `fullyMarked` travel with the score, because null
  is not zero at a boundary too.** `rawScore` is marks decided so far. Sending it
  alone loses "nobody has read three of these paragraphs yet" at the one place
  nobody downstream can put it back — and the thing downstream is a report card.
- **Attempts are incremented ON THE CLAIM**, so a job that kills its runner still
  dies rather than being retried forever. Exhausting `max_attempts` goes DEAD and
  is kept, with an audit row and a visible count — a delivery that disappears is
  an integration that fails silently for a month.
- **The timestamp is inside the signed string**, not merely a header beside it. A
  body-only HMAC is replayable forever, and a timestamp the replayer can also
  choose is not a defence.
- **`active` is re-checked at SEND time, not only at queue time**, so switching an
  endpoint off stops the backlog too rather than letting an hour of queued events
  arrive after somebody pulled the plug.

### Voice input

- **The Web Speech API, because the alternative uploads a child's voice.** No
  provider account, no key, no cost per minute, no server route. One honest
  caveat, stated in the file rather than asserted away: Chrome's
  `webkitSpeechRecognition` recognises on Google's servers, so "nothing leaves the
  device" is not true everywhere. What IS true everywhere is that no audio and no
  transcript reaches a Sahayak server or an AI provider, and the permission is one
  the student granted their own browser.
- **Unsupported means the control is ABSENT, not disabled.** The API is missing in
  Firefox and inconsistent elsewhere. A dead button costs a student thirty seconds
  mid-exam deciding whether the fault is theirs.
- **Dictation appends and never replaces**, and an empty final result returns the
  answer untouched rather than queueing an autosave for nothing.
- **It routes through the textarea's own `record()` handler.** No second
  persistence path, so autosave, the offline queue and `clientSeq` know nothing
  about voice and cannot disagree with it.
- **Three agreeing signals for recording state** — the button's name, the words
  "Listening", and the dot — because colour is never the only encoding here
  either. Stop uses `stop()` rather than `abort()`, so the last sentence is
  flushed instead of discarded.

### Tests that depend on the world staying unchanged

- **The database is never reset, so a test may not depend on a scarce shared
  resource staying unclaimed.** `bareChapter()` did `findFirstOrThrow` for a
  chapter with no outcomes, on the correct reasoning that 50 were in that state
  by design. Other suites author outcomes as arrangement; after enough runs there
  were **zero** bare chapters of 51, against 1,352 outcomes where 69 are seeded.
  The test then failed on a `NotFoundError` naming nothing about generation.
- **It is the hardcoded-phone-number rule inverted.** One claims a globally
  unique value that can only be claimed once; the other depends on a scarce one
  never being claimed. Both pass for months, both then fail forever, and neither
  failure points at what actually changed. A test authors what it needs.
- **The sharpest version SELF-CONSUMED.** `curriculum.test.ts` opened by finding
  a chapter with no topics and then, as its first act, added a topic to it. It
  ate one per run until 51 chapters had zero topic-less among them, and the suite
  died in `beforeAll` with a Prisma "no record was found" naming nothing about
  curriculum authoring. A fixture that both requires a state and destroys it has
  a countdown in it.
- **The same defect had reached a smoke check.** It asserted `/need outcomes/`
  appears on the curriculum console — a fact about the database, not about the
  console, which correctly renders "All chapters authored" once none do. What is
  under test is that coverage is STATED; both badges state it.
- **Three instances, and the fix is the same each time: author what you need.**
  On the platform connection, because the app role has no insert grant on the
  curriculum plane — which is also why this class of test reached for a seeded
  row in the first place.
- **But author only curriculum of your OWN.** A test that attached its concept
  to the shared seeded outcome — rather than to an outcome it created — put four
  concepts on the one outcome every `makeWorld()` uses, because concepts carry no
  `organization_id` and are therefore permanent and global. Gap detection began
  finding four gaps where the suite expects one, and eight unrelated intervention
  tests failed. It also broke the rule the concept editor already enforces: only
  outcomes nothing else covers may be linked, because the same answer counting
  towards two concepts splits the evidence for both. **The curriculum plane has
  no tenant, so there is no test isolation on it at all** — the property that
  makes cross-tenant intelligence possible is the same one that makes a careless
  write permanent.
- **And it was, 1,514 times.** By September 2026 the runs had left 1,514
  concepts ("Reporting concept 12 …", "Sweeper …", "Smoke concept 3") beside
  197 real ones, ~1,700 test outcomes inside real chapters, and twenty
  "Unwritten Subject" / "Empty subject" rows in every school's pickers.
  `scripts/clean-test-curriculum.ts` removed them, defining junk by what is
  REAL (the chapter list, the worked example, the drafts) rather than by
  guessing at names — guessing is how a real concept called "Ratio" goes.
- **So curriculum a test authors lives in a FIXTURE CHAPTER, and is taken away
  afterwards.** `fixtureChapter()` (integration) and `fixtureChapterNumber()`
  (smoke) number it at 1000 or above, which no syllabus has; the integration
  global teardown and the end of each smoke script call
  `removeFixtureCurriculum`, which deletes every fixture chapter and the run's
  concepts left measuring nothing. A concept linked to a real outcome is never
  touched. Two runs at the same time can pull a fixture chapter out from under
  each other — run them one after the other.
- **The teardown's first version removed nothing, silently.** `created_at` is
  `timestamp without time zone` holding UTC, and `pg` sends a JS Date with the
  machine's +05:30 offset, which the cast to a zoneless timestamp drops: "since
  12:24" against rows stamped 06:54. The clock now travels as UTC text.
- **A test that needs a subject with no chapters reuses ONE**, `ZZNOCHAPTERS`,
  upserted. A fresh subject per run cannot be cleaned up once a class points
  at it (`classes.subject_id` is RESTRICT). It has to sit in CBSE Class 10 —
  a class can only use its organization's own board — so
  `listGradesWithSubjects` hides every subject code starting `ZZ`
  (`FIXTURE_SUBJECT_CODE_PREFIX`); otherwise "Test fixture – no chapters" sat
  in every teacher's subject picker. Name any future fixture subject `ZZ…`.
- **A count over a real subject must ignore fixture chapters**, because during
  a run they are in it — `chapter.number < FIXTURE_CHAPTER_FLOOR`.
- **Never put `randomUUID()` in text an AI prompt might carry — use `textToken()`.**
  About one UUID in three hundred contains exactly ten digits starting 6–9,
  which is an Indian mobile number to `checkForLeaks`. The "tells the model what
  the bank already has" test quoted the first question's stem in the second
  prompt, the gateway refused it as UNSAFE_PROMPT, and the suite failed once in
  a few hundred runs — looking exactly like a flake under load, which is what it
  was first called. A unit test now pins both halves.

### The NCERT import

- **The question bank came from a sibling project**, `C:\dev\sirah_project\NCERT`:
  3,857 CBSE Class 9 and 10 MCQs, imported by `scripts/import-ncert-questions.ts`
  into the **Sirah Digital** organization and nowhere else. The importer kept
  no source id, so an imported question is re-identified by its content hash —
  sha256 over `["MCQ", normalised stem, sorted normalised options]`, the same
  hash duplicate detection uses. Every later script finds questions that way.
- **Four books had been filed into the wrong subject.** Footprints without Feet
  (`jefp1`) was under First Flight, and Economics, History and Political Science
  (`jess2/3/4`) were all under Geography — so "Class 10 Social Science chapter
  3" was four different chapters at once, and every tag against it would have
  been a coin toss. They are separate subjects now (`ENGFP`, `SSTEC`, `SSTHI`,
  `SSTPS`, Class 10 only, via `grades` and per-grade `names` in `seed.ts`), and
  `scripts/fix-ncert-filing.ts` moved the 740 questions by hash. Class 9 uses
  the NEW NCERT books (Ganita Manjari, Exploration), and the old Class 9 Maths
  chapters 9–12 were deleted.
- **The chapter list must live in `prisma/curriculum.ts`.** The seed upserts
  chapter titles from it, so a chapter created only by a script is overwritten
  or orphaned the next time somebody seeds.
- **Outcomes and concepts are DRAFTS, written against the books and the
  questions.** Twelve files in `prisma/curriculum-drafts/`, imported by
  `scripts/import-curriculum.ts`: dry run by default, `--commit` writes on the
  platform connection in one transaction, idempotent. It runs the same pure
  checks the console runs — `checkOutcomeStatement`, `checkConceptName`,
  `wouldCycle` — and nine statements it refused were REWORDED rather than the
  verb list loosened ("Finds", "Decides" and "Formulates" are not performable
  verbs in its list, and the rule exists because a statement is prompt material).
- **Tagging is one digit per question, and 0 means "not in the syllabus".**
  `prisma/question-outcomes/*.json` map each chapter to a string with one digit
  per question in source order, naming which of that chapter's outcomes it
  tests; `scripts/tag-questions.ts` refuses a length mismatch or an outcome from
  another chapter. 3,787 are tagged, and every one reaches a concept. The 70
  zeros test content CBSE has removed (Euclid's lemma, ogives, frustums, the
  mole concept …) and were ARCHIVED through `archiveQuestion` by
  `scripts/archive-out-of-syllabus.ts`, so a teacher cannot put a removed topic
  in a paper.
- **The 23 sample-paper marking schemes are DRAFT questions, never approved.**
  `scripts/import-ncert-rubrics.ts` goes through `createQuestion`, so the
  validator, `validateRubric` and the duplicate hash all apply. The source's
  prompts are abbreviated for a reviewer ("Carpooling case study. (i) Distance
  between B and C.") — no student could answer one — so a teacher completes the
  wording from the paper before approving.
- **A script that imports `core/` needs `npx tsx --conditions=react-server`.**
  `server-only` throws under any other condition.
- **The bank is NOT shared beyond Sirah Digital, and that is a legal gate, not
  a technical one.** 690 of the questions are verbatim NCERT Exemplar problems,
  © NCERT, and Sahayak is commercial; the NCERT project's own PERMISSIONS.md
  records the permission request as not yet sent. Until it is granted in
  writing, only the 3,167 original questions may be offered to other schools.
- **Sirah Digital also holds ~36,000 soft-deleted TEST questions**, moved there
  by a raw bulk SQL statement on 11 September 2026 that nobody can now
  reconstruct. They are left alone on purpose. It is why the attempt-sweep
  integration test asserts only on its own organizations' failures, and why
  any script touching that organization must filter `deleted_at is null` and
  `source = 'IMPORTED'` rather than trusting the organization id.

### Chapter contents from the books

- **`chapters.contents` is read from the NCERT chapter PDFs, never written from
  memory.** `prisma/chapter-contents/<book>.json` holds each chapter's printed
  sections, key terms, results, activities, exercises and summary;
  `scripts/check-chapter-contents.mjs` refuses any heading, activity or exercise
  name not found in that chapter's extracted text, and
  `scripts/import-chapter-contents.ts` writes them on the platform connection.
  The syllabus page and the printable index render them.
- **One extractor is not enough.** PyMuPDF scrambles small capitals, pdftotext
  gets them whole, and Kritika, Sanchayan, Kshitij and Sparsh are in the legacy
  Kruti Dev encoding and need converting to Unicode first. The checker takes
  every `--also` extraction. First Flight prints its exercise headings as
  pictures, read off page images and listed in `imageHeadings`.
- **The page image is the authority when text and memory disagree.** An agent
  wrote the familiar "highly enlarged, real and inverted" for an object at F; the
  2026–27 reprint prints "Image would not be formed". Another filled in Table
  6.1, which the book prints with blanks for students. Both were caught by
  looking at the page, and both are recorded as printed.
- **The Hindi chapter titles were authors' names** ("प्रेमचंद" for बड़े भाई
  साहब), and Kshitij 1 was a song from the section opener. The importer's title
  check caught it; the titles are now the lessons', in `prisma/curriculum.ts`
  and the database.

### The question library

- **The bank is COPIED into every CBSE school, not shared.** A school gets its
  own rows (`core/library`): it can edit, archive and set papers from them like
  anything a teacher typed, and nothing it does reaches another school. The
  costs are ~3,000 rows a school and that a correction to the source does not
  flow out on its own. That was a product decision, taken knowingly.
- **What may be copied is decided by COPYRIGHT.** `questions.provenance` is
  ORIGINAL or NCERT_EXEMPLAR, stamped by `scripts/mark-question-provenance.ts`
  by matching content hashes against the two Exemplar source files — 690
  Exemplar, 3,167 original, exactly the numbers the import predicted. Only
  APPROVED questions with a provenance are copied; the CBSE sample-paper drafts
  are unstamped and never go. Exemplar questions go only when
  `QUESTION_LIBRARY_INCLUDE_EXEMPLAR="true"`, which must not be set before NCERT
  grants permission in writing.
- **Signup does nothing extra.** `organizations.library_requested_at` defaults to
  now() in the database, so a new school is queued by its own insert; the
  `share-library` cron copies into five schools a run. A path that must not fail
  gains no side effect.
- **The migration requested NOBODY that already existed** — the column got its
  default only after it was added. This development database holds ~16,000
  organizations and every one but Sirah Digital is a test tenant; copying 3,154
  questions into each would be ~50 million rows. A real existing school is given
  the library by name with `scripts/share-question-library.ts --org <slug>`.
- **Copies are written as the school's owner, with `approved_by_id` empty.** The
  owner, because a school's own screens must be able to resolve the author; no
  approver, because the approval happened in the library and naming the owner
  would put a decision in their name they never made.
- **Idempotent twice over**: `library_origin_id` and the per-tenant content hash.
  Re-running copies nothing; switching Exemplar on re-queues every school
  (`library_includes_exemplar`) and copies only the 690.
- **A full copy is about 8 seconds**, in 400-row transactions so no single one
  approaches `withTenant`'s timeout.

### Reviewing the curriculum

- **`/admin/review` is where a subject teacher signs off the NCERT drafts** — outcome,
  concept and question tag, each with its own `reviewed_at`. Reviewers are
  platform admins (granted with `scripts/grant-platform-admin.mjs`), because
  approving curriculum is a write only `sahayak_platform` may make.
- **Any edit clears the stamp.** `updateOutcome` clears an outcome's; renaming,
  linking, unlinking or changing a prerequisite clears a concept's. The review
  was given to the previous version — the same rule as an approved question
  becoming a new draft version when edited.
- **There is no "approve all"**, and that is the design. A reviewer who can
  approve forty outcomes with one press approves forty outcomes unread, and a
  stamp nobody read is a claim that is untrue.
- **A tag may only move within the question's own chapter**, the rule the
  tagging script and the question validator already enforce.
- **Tags are reviewed on the LIBRARY'S questions** (the source organization's),
  so a corrected tag fixes the library; schools already synced keep their copy.
- **Its class names are `ui-cr-*`.** `results.css` already owns `.ui-review`.

### What a green suite did not catch (September 2026)

Every check was green — unit, integration, 766 smoke checks, 188 browser tests —
when four agents used the product in a real browser, as a teacher, a student, a
parent and an admin, on an organisation holding the real library. They found
about sixty-five defects. The lessons are about where tests stop looking:

- **A test that never reloads never finds the reload bug.** The player started
  `clientSeq` at 1 on every page load, and the server keeps a save only when its
  sequence is higher — so after a refresh mid-exam every changed answer was
  silently discarded while the header said "Saved". The player now resumes above
  the highest sequence the server holds (`resumeSequence`).
- **A revocation that a link can undo is not a revocation.** An accepted parent
  invitation stayed usable, and accepting reset `revoked_at`. Invitations now work
  once, a revoke cancels outstanding ones, and restoring access needs a new
  invitation, with the old period kept in the audit log.
- **Three components built answers three ways.** The player, practice and the
  mistake retry each turned input into a response; two sent numbers as text and
  multi-select as one key, so right answers were marked wrong. They share
  `core/attempts/response.ts` now.
- **A state machine fed by every submit needs its guard on the transition.**
  INTERVENING became PERSISTING on the next detection pass after anything, so a
  gap read "still there after an intervention" minutes after one was recorded.
  PERSISTING now requires a measurement that missed.
- **Fixtures hid the scale problems.** The assessment builder listed all 105
  chapters and the question step all 652 questions, because fixtures hold a
  handful. Test data the size of the real library finds these; a fixture of two
  questions never will.
- **Our own template broke our own importer.** The sample CSV's header
  `Mobile Number` matched no column, so every student imported without a phone.
  Generate the sample from the parser's accepted headers, and test the sample.
- **Hard-coded placeholders read as facts.** A dashboard card fixed at "Not enough
  evidence yet", a setup bar fixed at 66%, a landing page listing the old Class 9
  books and a demo declaring mastery from one answer. A number or a sentence
  nothing computes is a claim nobody checked.
- **A malformed id is a 404, not a 500.** Prisma throws on a non-UUID, so every
  `[id]` route validates the id before querying.

### Exam series

- **A series is a LABEL, and every refusal follows from that.** It holds no
  window, no marks and no status; each paper keeps its own window, results
  policy and marking. So assigning, sitting, marking and releasing are
  untouched, and a school that never makes one loses nothing.
- **No aggregate across a series, and no field to put one in.** "Half-yearly:
  68%" is the composite this product refuses everywhere else — no overall score
  per student, no class mastery score, no grade on a report, no readiness
  percentage — arriving where the pressure is strongest, because a series looks
  exactly like a report card. Six papers out of different totals, some part
  marked, some unreleased, do not average into anything defensible. A unit test
  asserts a rendered group carries only `seriesId`, `seriesName` and
  `sittings`, and an integration test greps the payload.
- **No status column.** Upcoming, running and finished are a function of the
  papers' own windows and the clock, exactly as an assignment's status is. The
  stored row is grepped for `status`, `opensAt`, `closesAt`, `total` and
  `percentage` in an integration test, and `seriesStatus` is pure so the badge
  a teacher sees and the figure the server renders are one function.
- **Mid-week is RUNNING, not FINISHED.** Monday's paper is over and
  Wednesday's has not opened, so nothing is open at this minute — which is most
  of a half-yearly week. "Finished" would be false and "coming up" worse.
- **EMPTY is a real state**, because a named series holding nothing is where
  every series starts. A cancelled paper is ignored when deciding, so a
  called-off last paper does not hold a half-yearly open forever.
- **Withdrawing a series does NOT cancel its papers.** The one thing this
  feature must never do: a teacher tidying up a label they mistyped must not
  silently cancel six exams a class is about to sit. `cancelledAt` on the
  series means "stop grouping these"; the confirm names the paper count and
  says they are untouched, the API answers with it, and an integration test
  asserts every paper is still `canStart` afterwards.
- **A paper is in at most one series — a column — and is never moved
  silently.** Adding one that already belongs elsewhere is a 409 naming the
  problem. A paper that quietly left the half-yearly when somebody built the
  pre-boards is a paper missing from a report nobody will re-read.
- **The picker offers finished papers too.** A school routinely sets six papers
  in a week and names the event afterwards; hiding shut ones would make
  grouping a half-yearly impossible the day after it ended.
- **A duplicate name in one academic year is refused**, ignoring case, spacing
  and the separator: "Half-Yearly" and "Half Yearly" are one event to everybody
  except a database. The refusal names the series that already exists, not the
  string just typed. The same name NEXT year is fine — schools reuse them.
- **The report STAMPS the series name on each sitting**, beside the id. A
  series renamed in December must not change what a parent was handed in
  September — the same invariant as the rest of that payload — and an
  integration test renames one and asserts the stored document did not follow.
- **Grouping is presentation and is derived, never stored twice.** The payload
  holds one row per paper carrying its series; `groupBySeries` in
  `ReportSheet.tsx` orders the groups by when they were sat and puts ungrouped
  papers last. A report with no series at all renders as the plain table it
  always was.
- **`PAYLOAD_VERSION` is 2, and the renderer now accepts anything UP TO the
  version it knows.** The old check was exact equality, which would have made
  every report stamped before this deploy render as "cannot be shown" — the
  product forgetting documents it had already handed to parents. Every version
  has only ever added optional facts, so an older payload renders with what it
  lacks treated as absent. A NEWER one still refuses, because this build cannot
  know what it would be leaving out. The integration tests assert the stamp
  against the constant rather than a literal.
- **`measuredWorld()` lives in `tests/integration/support/`** for the reason
  `makeWorld` does: a report refuses below three measured concepts, so every
  suite that wants a report rather than a refusal builds the same fixture, and
  two copies of one that size drift within a week.

### Practice a teacher asked for

- **It is an INSTRUCTION, not a new kind of assessment.** `assigned_practice`
  stores which idea, how many and by when; everything the student then does is
  an ordinary practice session with that id stamped on it, so the adaptive
  selection, the feedback after every question, the 30-day repeat rule and the
  evidence at `PRACTICE_WEIGHT` are the ones already built. There is no marks
  column, no pass mark and no submission, and an integration test greps the
  stored row for `marks|score|passmark|grade`.
- **The moment it is scored like a test, the tutor's rule starts costing
  marks.** Help means no evidence — which is right for a claim about what a
  student can do alone, and would be a punishment if this carried marks. So it
  does not, and the student's card says "no timer · no marks" before they start.
- **Late is not a penalty.** `due_at` orders the study plan and nothing else.
  Nothing turns red, and an overdue set reads "It was asked for earlier — it
  still counts". A unit test greps the plan item for *overdue*, *late*,
  *missed* and *should have*.
- **A deadline item, and therefore uncapped.** `MAX_ITEMS` exists to stop the
  product competing for a student's evening with its own suggestions; a
  teacher's instruction is not the product's suggestion. It sits under a
  half-finished paper — time already spent, about to be lost — and above
  everything else.
- **It survives the plan's refusal.** Every other item is derived from
  evidence and correctly refuses when nothing is measured. An instruction is
  not derived from evidence, so a student on their first day still has a plan
  if their teacher asked for something.
- **Home and `/student/plan` are built from the SAME inputs.** The dashboard
  calls `buildPlan` directly to read once for the whole page, so the assigned
  sets had to be threaded through `studentDashboard` too — two plans
  disagreeing on the same screen is worse than either being wrong alone. Same
  reasoning as `studentConceptStates` having one parser and two callers.
- **It refuses before it promises, with the number.** `assignPractice` counts
  the APPROVED machine-markable questions the school holds on that concept and
  refuses below the count asked for: *the bank holds 2 practice questions on
  Similarity of triangles, and you asked for 6*. A card on thirty home pages
  that cannot be honoured is the failure, and the count is clamped to what
  `startPractice` would actually serve so the card cannot promise twenty and
  hand over ten.
- **The concept must belong to the class's own subject** — the coherence check
  the question editor already makes. Practice on a History idea set to a Maths
  class would file its evidence under a syllabus those students are not
  measured on, and nothing downstream would look wrong.
- **Per concept, never per chapter.** Mastery is measured per concept and
  `core/practice` selects per concept, so a chapter-wide instruction would be
  several sets pretending to be one, with a count and a progress figure
  belonging to none of them.
- **An open set on that idea is ADOPTED, not duplicated.** A student already
  practising the thing they were asked to practise has done the homework; two
  half-done sets on one idea is exactly what the resume rule exists to
  prevent. The route verifies the instruction against `openForStudent` before
  it stamps anything — the id arrives in a request body, so it is checked, not
  trusted.
- **A finished one leaves the list rather than sitting there with a tick**, the
  study plan's rule, and a withdrawn one disappears the same way. Withdrawing
  is a stamp (`cancelled_at`), never a delete: the sittings point at it, and
  "what was asked for, and when was it withdrawn" is a question somebody asks.
- **The teacher sees COUNTS.** *8 of 30 done, 3 part way*. There is no mark to
  show and nothing else here to act on, and a marks column is the one thing
  this feature must not grow.
- **The flag belongs INSIDE `.ui-practice-set-body`.** `.ui-practice-set` is a
  flex ROW, so "Set by your Class 10-A teacher" as a direct child became a
  column beside the heading rather than a label above it — which is also how
  the study plan's own "From your plan" flag had been rendering.

### Exporting marks

- **Marks only. Never mastery.** An estimate is a belief carrying a denominator
  and a refusal band; in a spreadsheet it loses both and becomes a column
  somebody averages and ranks by — the composite the product refuses everywhere
  else, smuggled out in a file. A test greps the CSV for
  `mastery|estimate|band|concept`.
- **Null is not zero at the LAST boundary.** A paper nobody sat, and a paper
  whose written answer nobody has read, export an empty marks cell — with a
  `fully_marked` column and `marks_pending` beside it. The number alone would be
  read as a final mark by the one system that cannot ask.
- **The register says "3 (part marked)"** rather than printing a mark that is
  not finished. Three states, three different cells: never sat is blank.
- **Best attempt per paper, not last** — the same choice a term report makes,
  because attempts exist so a student can improve and reporting the final go
  punishes trying again. Two readers disagreeing about what a student scored is
  worse than either rule alone.
- **Every export writes an audit row.** A file holding a class's marks leaving
  the product is exactly what somebody asks about a year later.
- **A CSV carries a BOM and CRLF endings.** Without the BOM, Excel on Windows
  reads a Devanagari name as the system codepage and mangles it; CRLF is what
  RFC 4180 says and what school office software expects. A line break inside a
  quoted field stays part of the value and must not become a second record.
- **The download is a plain `<a href>` to a GET route**, not a fetch: the
  browser saves the file, the office can bookmark the URL, and the audit row is
  written server-side either way. `no-store`, because a marks file is a snapshot
  of a moment and a cached copy answers "what does the register say now" wrongly.

### The live view of a paper being sat

- **No marks while a paper is being written, and that IS the feature.** A
  percentage over a half-answered paper moves every minute and describes
  nothing — and a teacher watching one during an exam is watching one child.
  Progress is *answered N of M*, which is what an invigilator can act on. The
  query does not select `raw_score`, `percentage` or per-answer marks, and an
  integration test greps the whole payload for all three.
- **Derived at read time, stored nowhere** — the rule an assignment's status
  already follows. A stored "who is live" is a row that is a lie between
  ticks: a student shown as writing who handed in four minutes ago.
- **A blank is not an answer.** `response: { not: DbNull }`, or the room looks
  further on than it is.
- **Handing in and the clock running out are different states**, because only
  one of them is a choice. `submit_reason = TIMEOUT` is its own badge.
- **`tab_switches` stays where it is.** Proctoring is a different product and
  a different conversation about consent; this page shows who needs help.
- **The order is whoever needs the invigilator first** — writing, then not
  started, then finished; inside a group, least progress first.
- **The poll is 15 seconds and stops when the tab is hidden**, through
  `router.refresh()` rather than a second client-side reader that would
  eventually disagree with the server about who is still writing.
- **Its smoke check asserts a fact about the PAGE, not the database.** The
  first version asserted some row reads "3 of 4 answered", which is a claim
  about whether anyone had sat the paper in that smoke world. What must
  always hold is that the page states why marks are absent.
### The printed paper

- **It prints the FROZEN versions, so a DRAFT is refused.** `getAssessment`
  returns each question as it reads today, which is right for the builder and
  wrong for a printout: the source question may have been edited since, and a
  paper printed from the live wording is one the class sits but is not marked
  against. `core/assessments/paper.ts` reads `assessment_questions.question_version_id`
  instead. An integration test rewords a question after publish and asserts the
  printout did not follow.
- **Two documents, two URLs, never one with a toggle.** `/print` is what a
  class holds and its payload has no answer at all — options rebuilt as
  `{key, text}`, and `answerKey`, `rubric`, `explanation` and `hint` not
  selected. `/print/key` is the teacher's copy. A `showAnswers` prop would put
  the two one mistake apart, and the mistake is thirty photocopies of the key.
- **The key derives the answer the way the MARKING does.** A choice question's
  truth is `options[].isCorrect` and its `answerKey` column is usually NULL, so
  the first version printed "marked by hand" against every MCQ in the bank. A
  printed key that disagrees with the scorer is worse than no printed key.
- **The blank space is sized from the marks** (`marks × 2.5` lines, capped at
  14). It is the only signal in the data about how much is expected, and a
  one-mark question followed by half a page is what makes a printed paper feel
  machine-made.
- **A marks mismatch is stated on the sheet.** A blueprint of 20 carrying 18
  marks of questions is a paper somebody must fix, and the person holding the
  photocopies the night before is the one who can.
- **Tailwind's preflight strips every list marker**, so the instructions list
  asks for `list-style: decimal` back. Without it the instructions print as a
  paragraph somebody broke into lines — caught by a print screenshot.
### White labelling

- **Stored is not shown.** `organization_branding` keeps what a school typed;
  what RENDERS is that row gated by `can(orgId, "white_label")` at read time
  (`core/branding`). A lapsed plan shows Sahayak's look and deletes nothing, so
  a renewal needs no retyping. `white_label` is on the institute plan only.
- **The editor has two homes: `/institute/branding` and the foot of `/teacher/settings`**
  (owners and admins, plan permitting). So the save and logo routes are gated
  on `organization:update` plus `white_label` inside core — deliberately NOT on
  `admin_console`, or a plan with branding and no console would show an editor
  that cannot save.
- **Every signed-in layout (`/teacher`, `/student`, `/parent`, `/institute`) wraps its children in
  `BrandedSurface`**, which emits the theme `<style>` and a client
  `BrandProvider`. The shells read it through `BrandLockup` /
  `OrganizationName`, because `src/ui` may not import `@/core` and fifty pages
  render shells — a page cannot forget what it never had to pass.
- **A layout's title template does not apply to the page in its own segment.**
  `/teacher`, `/student`, `/parent`, `/institute` home pages use `brandedPageMetadata`, or they say
  "Dashboard · Sahayak" on a branded school. A smoke check caught it.
- **A full theme, and contrast is REFUSED, never clamped.** One brand colour
  derives the whole `--primary-*` scale (thirty-five rules use it directly, so
  overriding `--accent` alone leaves them indigo); surfaces and text may be set
  per mode. Every text colour is measured against every surface in both modes,
  and each pair must reach `min(AA, Sahayak's own ratio)` — a stricter bar
  refuses the default palette, which has a few pairs just under 4.5 on surfaces
  the token is never drawn on. The mastery colours are not themeable at all.
- **`storedTheme` re-validates on every render.** A row written by psql or a
  migration that fails renders as the default; `themeCss` admits only
  six-digit hex and throws rather than emit anything else into `<style>`.
- **`suggestBrand` offers the nearest darker shade that passes and never swaps
  it in.** Gold and saffron are common school colours and all fail white
  button text.
- **Fonts are a fixed set declared with `preload: false`**, so a face costs a
  download only on a school that picked it.
- **Logos are `bytea`, typed by their first bytes, never by the upload's
  Content-Type, and SVG is refused** — it can carry script and would run as our
  origin. Served with `nosniff` and `default-src 'none'; sandbox`. Logo rows are
  immutable: replacing moves `logo_id`, because a stamped report points at the
  old one.
- **A report STAMPS the letterhead** (`reports.letterhead`), for the payload's
  reason: a sheet signed under one principal must not name the next when
  reprinted. Null for an unbranded school, which renders as before. A school's
  footer prints ABOVE the product's caveat, never instead of it.
- **`/school/<slug>` is the branded sign-in page**, served by
  `app_public_branding` / `app_public_logo` in `rls.sql` through
  `core/branding/public.ts` (on the ESLint unscoped list). No organization id,
  no official details, current logo only. Unknown, unbranded and unentitled
  schools are the same 404. The SQL restates the entitlement rule because
  there is no tenant to ask `can()` with; `branding.test.ts` holds the two
  against each other across subscription states. The slug picks the logo, never
  the tenant — sign-in works exactly as on `/signin`, minus the signup link.
- **Not branded, deliberately:** SMS (DLT templates are registered text),
  webhook headers, the landing page and `/admin`.
- **A `<fieldset>` defaults to `min-inline-size: min-content`**; `min-width: 0`
  does not override it. The editor overflowed a 360px phone until a screenshot.

### Joining a class

- **Join-by-code is scoped to the student's own organization**, and a code from
  elsewhere gets the same answer as a wrong one: *no class here uses that code*.
  Distinguishing them would turn the form into a way of testing whether a code is live
  somewhere on the platform.
- **Cross-organization joining is deliberately not half-built.** It needs three things
  together — a pre-tenant code lookup, a membership in the second organization, and an
  organization switcher in the session — and none of them exists yet. Enrolling a
  student in a class they could never open would be worse than refusing.
- **Joining twice is not an error.** A student who taps the button twice, or who was
  already added by their teacher, lands in the class either way.

### Configuration

- **Every capability degrades quietly, and together that is the failure.** No
  AI key and the AI layer falls back to a mock; no `CRON_SECRET` and the
  scheduled jobs refuse everything; no SMS provider and sign-in codes go
  nowhere. Each is a good decision alone. Together they let a deployment come up
  green, serve pages, and be unable to sign a single student in — with nothing
  saying so, until a fifteen-year-old is holding a phone that never buzzes.
  `src/config/environment.ts` says it once, at boot, in the deploy log.
- **Fatal is for CONTRADICTIONS, not for absence.** `SMS_PROVIDER=msg91` with no
  API key is not "SMS is off" — it is somebody who meant to turn SMS on and
  mistyped a variable name, and falling back silently hides their mistake behind
  a product that looks fine. A missing AI key is genuinely off and is only
  reported: refusing to boot over it would make the product undeployable for
  anybody not paying for AI.
- **The report says what IS live, not only what is not.** A log that lists three
  warnings and nothing else reads like a broken deployment.
- **Every finding names a variable and what to do.** Never "check your
  configuration", and never "scheduled jobs are disabled" — which jobs, and what
  goes stale, is the part somebody can act on.
- **`.env.example` ships every key as `""`**, so a copied file has the name
  present and the value blank. The check treats an empty string as missing,
  because it is.
- **There is no session secret, and there never was.** `.env.example`, the
  README and `DEPLOYMENT.md` all declared `SESSION_SECRET`, and `SECURITY_MODEL.md`
  described a two-secret rotation "so rotation does not sign every user out".
  Nothing has ever read it. A session token is 32 random bytes stored as a
  SHA-256 hash and looked up by that hash — opaque, no claims, nothing to sign.
  An operator who rotated it believing it would sign everyone out would have
  changed nothing. The same class of defect as a contrast ratio measured against
  the wrong background: a document asserting something nobody checked.

### SMS

- **The same shape as the AI layer, because it is the same problem.** A paid
  external provider, on a path that must not fail, sending something whose exact
  wording a regulator has approved. So it gets the same treatment: business
  logic names an INTENT, one directory names a vendor, `sendSms()` is the only
  door, and an ESLint fence rejects `@/sms/provider` everywhere else.
- **It never throws.** Delivery sits on the sign-in path. A student who cannot
  get a code because the provider is down is a bad afternoon; a student who gets
  a 500 on the sign-in form because the provider is down is a broken product.
- **Issuing and delivering are different acts, and the difference used to be
  invisible.** `requestLoginCode` returned `{ ok: true }` while sending nothing,
  and the route answered `sent: true` unconditionally — so the screen told every
  student to check a phone that was never going to buzz. It now returns
  `delivered`, and the screen says "Code created for" and names the failure when
  it is false. A failed send does NOT roll the code back: the row exists and its
  clock is running, so the honest report is "issued, not delivered".
- **Two limits, and conflating them would be the bug.** `app_auth_issue_code`
  refuses many codes to ONE number — that protects somebody's phone, and it is
  the product promise. `DAILY_CEILING` refuses many codes to MANY numbers — that
  protects the BILL, because an attacker cycling through ten thousand numbers
  passes the per-number limit every time and spends real money doing it. Same
  distinction the AI gateway draws between `usage_counters` and `ai_budgets`.
- **The ledger is written for the support call.** A student says they did not
  get their code; without a row the only honest answer is "we do not know", and
  "the API returned 200" is not an answer about whether a phone buzzed. Every
  attempt is recorded, including the ones that were never sent — `SKIPPED` is a
  status, because silence looks identical to a bug.
- **`sms_messages.organization_id` is nullable, and that is the pre-tenant seam
  again.** A student signing in has no tenant yet — the code is what will
  eventually tell us which one. So the row belongs to nobody, the tenant policy
  correctly refuses to let the app role write it (`NULL = app_current_org()` is
  NULL, not true), and the write goes through narrow SECURITY DEFINER functions
  in `rls.sql` reached only from `src/db/unscoped.ts`. Exactly where
  `app_auth_issue_code` already lives, for exactly the same reason.
- **The platform console gets a COLUMN grant, not a table grant.** `/admin` is
  documented as reaching four tables that carry no student work, and a phone
  number is a contact detail. Postgres grants per column, so `phone` and `error`
  are simply not in the grant — the console can see what SMS costs and how much
  of it fails, and cannot see who it went to. Reading a specific number back is
  a support action over DIRECT_URL, the same place granting a platform admin
  lives.
- **A DLT template is not a string you can edit.** India requires every
  commercial SMS to match a template registered with a DLT registry under a
  registered header; the operator drops anything else at the network, silently.
  So the body lives beside the id it was registered under, changing a word means
  re-registering, and `buildBody` throws on the wrong number of variables rather
  than padding — a wrong arity is a message that never arrives and never
  explains why.
- **The code is never written anywhere it can be read back.** Not in the ledger
  row, not in a log line. `describe()` exists so a row can say WHICH message was
  sent without repeating what was in it. A one-time code in a log file is a
  credential in a log file, and log files outlive the incident that raised the
  log level.
- **Turning it on is paperwork, and `docs/SMS_SETUP.md` is the checklist**: DLT
  entity, header and the two templates registered with the exact text
  `scripts/sms-test-send.ts` prints, then MSG91, then one real test send.
  Development sets `SMS_PROVIDER="log"` in `.env.development.local` only: in `.env` it also reaches `npm start`, and the boot check rightly refuses to start with it.
- **`SMS_PROVIDER=none` is a real state, not a misconfiguration**, and it is the
  default. This product has no provider account yet, and that has to be
  distinguishable from a missing environment variable — so it is chosen
  explicitly rather than inferred from whether a key happens to be set.

### The AI layer

- **Business logic names a TIER. Only `src/ai/models.ts` names a model.** Moving
  BALANCED to a different model is an environment variable, not a deploy. A model id
  in a route handler makes a cost decision, a quality decision and a migration into
  one change nobody wants to make.
- **`src/ai/anthropic.ts` is the only file allowed to import the SDK**, and the ESLint
  block for it is the LAST block in the config — flat config merges last-wins per
  rule, so that block has to restate the database restrictions or the provider
  silently gains access to them.
- **The order in the gateway is the design**: concurrency → budget → scrub → leak
  check → call → validate → retry or refuse → ledger. Budget before the call, because
  a limit checked afterwards is a report. The ledger after *every* call including the
  failures, because a retry storm is invisible in a success-only ledger and that
  invisibility is what produces a surprise bill.
- **Scrubbing is an allow-list, not a deny-list.** A deny-list ships whatever the next
  feature adds to its payload. A field added later goes missing from the prompt —
  visible as a bad answer — rather than being sent, which is not visible until it is a
  headline. Declaring a never-list field throws rather than being quietly dropped.
- **`checkForLeaks` runs on the ASSEMBLED prompt**, because a prompt is built from
  template strings and a template is exactly where a name gets interpolated without
  passing through a scrubbed payload at all.
- **The gateway never throws.** Every failure is a typed result — no AI call is on a
  blocking path, and a feature that has to try/catch around one will eventually
  forget.
- **A refusal is never retried.** The model's decision will not change, and trying
  again spends money to be told the same thing. Malformed output gets exactly one
  repair turn, appended *below* the cache breakpoint so the retry still reads the
  cached prefix.
- **Provider messages go to the log, never to a person.** "MockProvider: nothing
  scripted" is true and useless to a teacher who pressed a button; `USER_MESSAGE`
  says what happened and what to do.
- **Nothing volatile above the cache breakpoint.** The system prompt is assembled from
  sorted, stable inputs only — a timestamp or an unsorted list up there invalidates the
  prefix and roughly triples the bill with no other symptom. There is a test asserting
  two calls produce a byte-identical prefix.
- **Generation refuses a chapter with no learning outcomes.** The outcome statement is
  the only grounding a generator has for what a chapter is *for*; without one the model
  writes plausible questions about a title.
- **Two gates on a generated question, in that order.** The deterministic
  validator first — cheap, certain, and it removes the drafts not worth paying a model
  to read. Then the FAST-tier reading gate, for the failures a rule cannot see: the
  answer sitting in the stem, a question needing a chapter they have not reached,
  four options of which three are obviously silly.
- **Reject and flag are different, and the difference is the design.** REJECT is only
  `answer-in-stem` and `out-of-scope` — objective failures nobody should spend
  attention on, and those never reach a teacher. Everything else is a FLAG that
  reaches them with the reason on the card, because a machine overruling a teacher on
  a judgement is how a product gets turned off.
- **A "reject" carrying no rejecting reason is read as a flag**, and a verdict
  pointing at a draft index that does not exist is discarded. A model that renumbers
  lands its verdict on the wrong question, which is worse than no verdict.
- **If the validator cannot run, the drafts still arrive, unflagged.** AI is never on a
  blocking path, and a validator that is down must not mean a teacher gets nothing.
- **The validator is not metered against the generation allowance.** It is part of what
  generation promises, not a second thing a teacher spends — charging twice for one
  press is a surprise on an invoice.
- **The class narrative is behind a button, not on page load.** A page that wrote a
  paragraph on every refresh would bill a teacher for refreshing, and the note is a
  second opinion on figures they should read first. It refuses outright when nothing is
  measured, because a paragraph of hedging teaches a teacher the feature has nothing
  to say.
- **A generated question passes exactly what a typed one passes** — the same
  validator, the same curriculum-fit check, the same duplicate hash, the same DRAFT
  status. What generation adds is a filter *before* the human: a draft that fails
  validation is dropped and never reaches the queue, because a teacher reading eight
  questions of which three are malformed learns to skim.

### Analytics

- **The refusal has to survive aggregation, and that is where it gets undone.**
  Twenty-four students, three with enough evidence, average those three and print it
  as "the class": arithmetically correct, factually false. Below `MIN_MEASURED` a
  concept reports `meanEstimate: null`, and every figure that does exist carries the
  denominator it was computed over.
- **A student with no row is INSUFFICIENT, not zero.** Somebody who has sat nothing
  appears in the grid with empty cells and is excluded from every average. Leaving
  them off the grid entirely makes a class that mostly ignored the test look like a
  class that did well.
- **There is deliberately no single "class mastery" score.** Averaging across concepts
  produces a number that moves when the syllabus moves — and it is exactly the number
  that would get printed on a report and compared between teachers.
- **The heatmap cell carries the estimate as a number.** Colour is never the only
  encoding: the grid has to survive a colourblind reader, a bad projector and a
  printout. All four mastery colours hold white text above 4.5:1.
- **The concept column order is sorted, not incidental.** A grid whose columns
  reshuffle between two page loads is a grid nobody can compare.
- **`studentProfile` checks membership, not the `users` table.** User rows are global;
  being able to name somebody is not the same as them being your student.

### Mastery

- **The estimator is pure, and that is not a style preference.** A mastery figure is
  what this product asks a teacher to change a lesson plan on. It has to be
  re-derivable from stored evidence, months later, by somebody who was not in the
  room — which a function that reads a database cannot be.
- **Two tables, and the split is the whole design.** `concept_evidence` is an
  append-only record of what happened; `student_concept_mastery` is a belief derived
  from it. Deleting every estimate and recomputing must produce identical values, and
  an integration test asserts exactly that. Without the ledger, changing the algorithm
  silently rewrites history and nobody can tell whether the students improved or the
  formula did.
- **A Beta posterior, not `correct / attempted`.** A percentage over three questions is
  noise presented as a fact. The posterior carries its own spread, which is what makes
  the refusal expressible at all: the same 0.6 from three answers and from thirty is a
  different claim.
- **The refusal is a discriminated union, not a rule to remember.** `Mastery` has no
  `estimate` field when the band is INSUFFICIENT, so a component that renders one does
  not compile. The column is null too — a number the product refused to stand behind
  should not sit where the next feature's join can average it into something that
  looks authoritative.
- **Two thresholds, not one.** Four raw answers AND enough undecayed weight. Five
  answers from eighteen months ago pass a raw count and say nothing about this student
  now.
- **Getting an EASY question wrong is the most informative thing a student can do.**
  The difficulty weighting runs in both directions; a model that only rewarded hard
  correct answers would let somebody fail every easy question and still look fine.
- **Evidence appears when an answer is MARKED, dated to when it was SAT.** A written
  answer is not evidence until a person reads it, and a December marking session is
  not December evidence — the recency decay measures from the sitting.
- **The ledger write happens after the submit transaction commits, never inside it.**
  Sixty upserts inside the transaction that finishes an exam means a slow query can
  cost a student their paper. If the ledger write fails the paper is still safe, and
  `rebuildMastery` re-derives it.
- **Recency decay needs something to run.** Time passes whether or not a student
  answers, so `/api/cron/refresh-mastery/` recomputes stale rows. Without it a student
  who stopped work in July keeps July's confident number into December.
- **An outcome no concept covers can never inform mastery.** The importer warns
  on an outcome no concept in its draft covers; the risk that remains is an
  outcome authored later in the console and never grouped.
  Designed, not broken: concepts are authored by somebody who teaches the subject.
  `conceptCoverage()` puts the number on the platform console so it is not discovered
  as an empty analytics page six months later, and `/admin/curriculum/concepts` is now
  where it gets fixed — until that screen existed the console could report the hole
  and nobody using the product could close it.

### Results and marking

- **A statistic over half-marked papers is not a smaller statistic, it is a wrong
  one.** Every cohort figure is computed over fully marked attempts only, and the
  count left out travels with it: *62% across 18 of 24 papers*. An average that
  counted an unread three-mark answer as nought would tell a teacher their class
  struggled with a question nobody has looked at.
- **Below three marked papers there are no figures at all.** The same refusal the
  mastery scale makes below its evidence threshold, and it lives in `core/` so a
  number that must not be shown never reaches a component. Four cards reading "0%"
  off one marked paper says the class failed when nobody has marked the rest.
- **The marking queue is ordered by question, not by student**, and hides names by
  default. Twenty-four answers to one question are marked against one mark scheme
  held in the head; twenty-four whole papers are marked against a standard that
  drifts, and neither the teacher nor the student ever finds out.
- **The queue needs an explicit `orderBy` or it reshuffles under the marker.**
  Postgres may return rows differently on the next read, so after each saved mark
  "Answer 3" became a different student's answer.
- **A mark outside the question's range is refused, never clamped.** A teacher
  typing 30 into a 3-mark box has made a mistake, and storing 3 hides it from them
  now and from the student's total forever.
- **Partial credit stores `isCorrect: null`.** 2 out of 3 is neither right nor
  wrong, and `false` would tell the analytics the student did not know it. So the
  result page derives its state from the marks, not from `isCorrect` — reading
  that field first put a partially marked answer in the "nobody has marked this"
  box.
- **Releasing is permitted while marking is outstanding, and says how many papers.**
  Twenty students are not held back by four unmarked ones, and those four already
  see "marked so far" with the marks still owed named.
- **The answer key waits for the window to close, even under IMMEDIATE.** The score
  is theirs the moment they submit; the key is a stronger disclosure, and a class
  sitting in two sessions would otherwise have the first session holding the
  answers while the second is still writing. `reviewable` is that gate, separate
  from `visible`.
- **`rescoreAttempt` never re-marks.** It totals what the marker and the teacher
  already decided. A function that re-marked on every save would overwrite a
  teacher's judgement with the machine's the next time anything touched the row.

### Assessments

- **Publishing freezes the question versions.** Each row stamps the version served, so
  a paper written in August keeps marking the way it did in August after the source
  question is edited in December. A DUPLICATE deliberately does not copy the frozen
  versions — it is a new draft and freezes afresh.
- **A published paper is never edited.** It is closed, or duplicated into a new draft.
  Both `updateDraft` and `setQuestions` refuse once status leaves DRAFT.
- **Only APPROVED questions may be published**, and `bankInventory` counts only those.
  Counting drafts would make the feasibility check optimistic in exactly the way that
  wastes a teacher's evening.
- **Feasibility is answered at step 3, not step 5.** `planSlots` compares the blueprint
  against what the bank actually holds and names the gap: *you asked for 6 hard
  questions on Similarity and the bank has 2*. Told while the mix is still being chosen
  that is a decision; discovered at the end it is a wasted evening.
- **`allocate` never loses a question to rounding.** A blueprint promising 7 questions
  allocates 7 — the remainder goes to the largest shares. Property-tested.
- **The blueprint is seeded from the teacher's own numbers**, not from the constant.
  Opening step 3 with "20 questions" under a paper set to 4 marks is the builder
  contradicting itself before the teacher has done anything.

### Questions

- **One validator, three callers.** `core/questions/validate.ts` is pure and runs live in
  the editor, again on the server at save, and (from slice 11) over every AI-generated
  draft before a human sees it. "Valid" therefore means the same thing everywhere.
- **Errors block, warnings never do.** An error is something that would be wrong in a
  real exam — two correct options on a single-answer item. A warning is advice: an
  "all of the above" option, a correct option twice as long as the others. A rule that
  fires on good questions gets ignored on bad ones.
- **An approved question is immutable.** Editing one creates version n+1 and drops it
  back to DRAFT, because the approval was given to the previous wording. Version n stays,
  because attempts record the version they were served.
- **A question with no learning outcome can be saved but never approved.** It can be
  scored and will never inform mastery, which makes it worthless to the part of the
  product that matters.
- **Curriculum coherence is checked on the server, and it is an ERROR.** A question filed
  under Hindi with a Mathematics chapter scores correctly and then attributes its
  evidence to the wrong syllabus forever — nothing downstream looks wrong. Found by
  reading a screenshot, not by a test. See `checkCurriculumFit`.
- **The correct-answer control is a button, not a checkbox**, on the single-answer types:
  it MOVES the mark rather than adding one, so the error that costs a student a mark
  cannot be expressed by accident.
- **Duplicate detection is per tenant and hashes normalised content**, sorted options
  included — reordering choices does not make a new question. Two centres may
  legitimately hold the same question and neither learns about the other's bank.

### Roster

- **One parser serves both paths** — pasting and CSV differ only in delimiter and header.
  The dry run and the commit share it, so the preview cannot disagree with the outcome.
- **A mixed list is ambiguous and treated as such.** The delimiter detector refuses a
  list where only some rows carry a comma, because `Nair, Meera` is a name. A trailing
  run of *digits* is unambiguous, so `Meera Nair, 12` still splits.
- **Column roles in a headerless list come from the content, not the position.**
  `Arun Kumar, 9876543210` is the commonest thing a teacher pastes, and a fixed
  name/roll/phone order put that number in the roll column, rejected it there for
  looking like a phone, and dropped it. The student imported cleanly with no phone, no
  warning — and could then never sign in, because a phone number is the only thing a
  student signs in with. Ten or more digits is a phone; a majority of the column
  decides, so one blank number does not move it.
- **Imperfect data is imported, not rejected.** A bad phone costs the row its sign-in,
  never its place on the roster — and the class page counts how many students cannot yet
  take a test, rather than letting that be discovered on exam day.
- **A teacher cannot add a phone number that already has an account.** That is the
  correct security boundary, not a limitation: otherwise any teacher could attach any
  student to their roster. The student joins the second class themselves, with the class
  code. The refusal message never says which organization holds the number.

### Design

- **`src/app/globals.css` is the design system.** Every contrast ratio in its comments is
  measured, not estimated. `--neutral-400` is documented as *failing* text contrast
  (2.53:1) because it is the token most likely to be misused for a caption.
- **The chart series palette is validated, not chosen.** Slots are assigned in fixed
  order and never cycled; the series cap for scatter forms is 3. Re-run the validator
  before changing any of it.
- **The mastery scale is reserved.** Five bands, and the fifth is a refusal: below the
  evidence threshold the UI shows "not enough evidence yet" and never a number. Enforced
  in `core/`, so a value that must not be displayed never reaches a component.
- **A StatCard with no data shows an em dash, never a zero.** 0% and "no data yet" mean
  opposite things to a teacher and only one is a reason to change a lesson plan.
- **`.ui-button` carries the secondary appearance in its base rule too.** A forgotten
  `data-variant` used to render as bare text on the page background — an invisible
  control, which is worse than an ugly one, and it shipped in the intervention panel
  until a screenshot caught it. Every variant overrides background, colour and
  border-colour, so `ghost` and `primary` are unaffected. Same lesson as `data-size`
  above, learned twice.
- **Inline `style` beats the stylesheet.** A `style={{display:"block"}}` in `AppShell`
  silently defeated the mobile `display:none` for a whole build. Put display rules in
  `ui.css`.
- **A row that wraps puts a destructive button under the wrong name.** The student list
  let "Remove" wrap to its own full-width line on mobile; it now shares row one with the
  name. Check any grid that carries a destructive action at 390px.
- **One class name, one component — across stylesheets too.** `.ui-result-score` meant
  the big score panel in `student.css` and a table cell in `results.css`, and whichever
  loaded second won: every row on the teacher's class list rendered as a 26px-padded
  card. Grep the other stylesheets before naming anything `.ui-*`.
- **A bare `.ui-grid` used to be a one-column grid.** The columns lived only under
  `[data-cols="auto"]`, so a hand-written `<div className="ui-grid">` laid four stat
  cards out as four full-width blocks. Now in the base rule, same as `.ui-button`.
- **Hover is not an affordance on a phone.** An expandable row needs a caret that is
  visible before it is touched.
- **The September redesign broke four documented rules at once, and e2e caught
  all of them.** Nav items at 38px under a thumb; a top bar and a student bar
  that pushed the page 15–49px wider than a 360px phone once links grew to 44px
  targets; a roster textarea with a placeholder and no label; and the class
  page's no-mobile warning rewritten to say those students "can still
  participate by using the Class Join Code" — false, because a phone number is
  the only way a student signs in, and joining by code needs a session. A
  friendlier sentence that is untrue is worse than the blunt one it replaced.
- **`.ui-student-name` collided again, the `.ui-result-score` bug a second
  time.** student.css hid it at 640px for the student bar, and the teacher
  roster used the same class, so on a phone a class list showed roll numbers
  and phones and no names. The student-bar rules are now scoped to
  `.ui-student-bar`. Grep every stylesheet before naming anything `.ui-*`.
- **Wrapping an element breaks the grid rule that placed it.** The roster's
  mobile grid placed `.ui-student-name` in row 1; the redesign put the name
  inside an avatar wrapper, so the rule placed nothing. The wrapper is
  `.ui-roster-person` and the grid places that.

### The framework

- **A surface is gated by its layout, not by each page.** Every page under `/teacher`
  called `getSession()` and redirected only when there was none — so any
  SIGNED-IN user could read the teacher workspace, students and parents included.
  Tenant scoping held, so nothing crossed organisations; what leaked was every
  other child in the class to anybody with an account in it. Found by the parent
  portal's smoke check asking the question nineteen pages had never been asked.
  `/admin` had been built this way from the start; `/teacher`, `/student` and `/parent` now match it,
  because page twenty is written by somebody who has not read this file.
- **`trailingSlash: true` applies to route handlers.** POST to `/api/x/` or Next 308s and
  the request body silently vanishes on the redirect.
- **ESLint flat config merges last-wins per rule.** A later block setting
  `no-restricted-imports` *replaces* an earlier one rather than adding to it, so each
  block in `eslint.config.mjs` restates the paths it needs. Splitting them silently
  cancelled the layering rules once.
- **`eslint-config-next` 16 ships flat config directly** — import it, do not wrap it in
  `FlatCompat`, which throws a circular-structure error.
- **`server-only` throws in Vitest**, so it is aliased to a stub in `vitest.config.ts`.
  The guarantee is unaffected: `npm run build` still fails if a client component imports
  a server module.
- **Inter is self-hosted via `next/font`**, not a Google Fonts `<link>`. Students on 3G
  pay for a render-blocking third-party request, and some school networks block
  fonts.gstatic.com outright.
- **`react-hooks/set-state-in-effect` is an error.** `ThemeToggle` reads localStorage
  through `useSyncExternalStore`, which is the right primitive for a browser store. The
  player reads `navigator.onLine` the same way; anything else that reacts to a browser
  event belongs in the listener, not in an effect that watches derived state.
- **`react-hooks/purity` is an error too.** `useRef(Date.now() - x)` is a render-time
  impurity — measure the clock offset in a mount effect instead.
- **`.ui-button` now carries the medium size in its base rule.** A
  `<Link className="ui-button">` cannot default a prop the way `Button` does, and a
  forgotten `data-size` used to render a control with no padding and no height at all.

### End-to-end and accessibility

- **The suite covers only what a browser can prove.** 872 smoke checks already
  drive the real HTTP API against a real build; re-proving status codes and
  payload shapes in Chromium would double the runtime and the maintenance for
  nothing. E2E is for work surviving a refresh or a dropped connection,
  keyboard operation, axe violations, and layout at 360px.
- **A contrast ratio without its background is meaningless.**
  `--neutral-500` carried the comment *"4.51:1 — tertiary text"* since slice 0.
  That figure was measured against pure white, which is a surface the token is
  never used on: on `--canvas` it was 4.21:1 and on `--surface-sunken` 3.95:1.
  The first axe run found it under **86 nodes across 37 routes** — one token,
  not eighty-six bugs. Every measured ratio in `globals.css` now has to name the
  background it was measured against, or it is not a measurement.
- **44×44 is a TOUCH rule, so it lives in a media query.** Raising every button
  in the product would inflate dense teacher screens — the marking queue, the
  question bank — for somebody holding a mouse, to satisfy a rule that is not
  about them. It applies at `max-width: 640px` and at `pointer: coarse`, which
  also catches a tablet at 1024px.
- **That also resolved a contradiction in the design system.** §7 specified
  inputs as 40px tall; §6 and §14 required 44 as a minimum "checked in CI".
  Both were reaching for something true — §7 describes how a control looks under
  a mouse, §6 and §14 how big it must be to hit — and splitting them by pointer
  type meant neither had to lose.
- **A target big enough in one direction is not a target.** The first pass set
  only `min-height`, and a short breadcrumb came out 44 tall and 36.1 wide. A
  thumb does not care which direction was the easy one.
- **The first run failed 11 of 12 screens on tap targets and 37 of 50 routes on
  contrast.** Both had been promised in `DESIGN_SYSTEM.md` for months with
  nothing checking either. The student test player was the only screen that
  passed, which is consistent with it being the one surface built without the
  shared shell.
- **Keyboard and focus passed completely, first time** — 15 tab stops on the
  teacher dashboard, 13 on student home, every one carrying the documented 2px
  `primary-600` ring, and sign-in completable with Tab and Enter alone. The one
  claim in §9 that was already true.
- **`overflow-x: auto` needs `tabIndex={0}` and a name.** A region that scrolls
  but has no tab stop cannot be scrolled by a keyboard at all. axe only fires
  when the content actually overflows, so `/admin/audit` caught it at 390px and
  `/teacher/analytics/[classId]` did not — on a real class, it would.
- **Playwright's artifacts race on this filesystem.** Sibling runs share
  `test-results/` and delete each other's traces mid-run — which stalled two
  agents outright — and even a single run dies at teardown with ENOENT about
  one test in eight. `outputDir` now points outside the repository, per process,
  and tracing is off except on a CI retry.
- **Arrangement goes through the API; the flow under test goes through the UI.**
  A student-attempt test that clicks through signup, a class, a question, a
  paper and an assignment spends ninety seconds re-proving three other tests and
  breaks whenever any of those five screens changes. The one exception is flow
  1, where signing up IS what is under test.
- **`context.request` shares the browser's cookie jar**, so authenticating
  through it leaves the browser signed in and no cookie is ever handled by hand.
- **Dead code is untested code.** `signInTeacher` in the harness posted
  `{ email }` when the route has taken `{ identifier }` since student sign-in
  landed — a hard 400 that nothing noticed, because every caller until then
  authenticated some other way.

### Editing files from a script

- **Do not push `` (or any backslash escape) through a shell heredoc into Python.**
  Two layers of escaping turned `\b` into a literal backspace byte, which landed
  invisibly in a `.tsx` file and broke the build with a message that named nothing
  useful. Prefer the Write/Edit tools for source; where a regex needs a word boundary,
  a character class such as `(?:^|[^A-Za-z0-9])` says the same thing with no backslash.
- **Source files here are CRLF.** A Python patch script must detect the file's line
  ending and normalise its own literals to match, or every `assert old in src` fails for
  a reason that looks like the text not being there.
- **A newline escape inside a heredoc-fed Python string does not survive.** Build test
  fixtures with a placeholder character and substitute it, or write the file with the
  Write tool.
- **These files have CRLF endings.** Splicing them by `split("
")` leaves stray `
`
  and doubles every line. Rewrite whole files rather than splicing lines.

### Supabase

- **Supabase is the only database; local Docker is for the tests.** docs/SUPABASE.md
  is the runbook. Every URL uses the SESSION pooler (5432): the direct host is
  IPv6-only without a paid add-on, and the transaction pooler (6543) breaks
  Prisma's prepared statements. The app roles connect as `sahayak_app.<ref>`.
- **Every test suite refuses a remote database** (`scripts/lib/local-database.mjs`,
  called from the integration setup, the global teardown, all 23 smoke scripts and
  playwright.config.ts). One integration run creates hundreds of organisations; the
  local database reached ~17,000 that way. It reads the same `.env` the server
  reads, because a smoke script only talks to the server — if `.env` points at
  Supabase, so does the server it would be filling.
- **Supabase grants `anon` and `authenticated` every table, and Postgres grants
  EXECUTE on every function to PUBLIC.** With the curriculum policies being
  `using (true)`, the syllabus would have been readable with the project's public
  anon key, and the pre-tenant SECURITY DEFINER functions callable as RPCs. The
  last block of rls.sql revokes both and re-grants EXECUTE to the two app roles; it
  runs only where `anon` exists.
- **The move was rehearsed, and the rehearsal found three things a first real run
  would have hit:** a migration seeds a CBSE board row whose id no subject points at
  (the target is emptied before copying); `pg` reads zone-less timestamps as local
  time, which would have shifted every date by 5h30 (timestamps travel as text);
  and `json_populate_recordset` turns a stored JSON `null` into SQL NULL, which a
  ROW COUNT did not catch and a content comparison did
  (`scripts/verify-supabase-copy.mjs` compares every row as JSON).

### Local environment

- **Postgres is Docker `sahayak-pg` on host port 5434.** 5432 usually belongs to another
  project, and on this machine 5433 belongs to `setu-postgres`.
- **Kill the dev server before re-testing a build.** A zombie `next start` kept port 3210
  and a readiness probe passed against the *old* code, producing three confident,
  fictitious failures. `npm run smoke` now probes the server before it starts.

## Things not to do

- Do not read `organization_id` or a role from a request body, query string or header.
- Do not call `prisma` directly outside `withTenant()`.
- Do not add a tenant table without a policy in `prisma/rls.sql`.
- Do not make the RLS audit non-blocking.
- Do not render a mastery number that `core/` marked `INSUFFICIENT`.
- Do not let a preview run different logic from the commit it previews.
- Do not hardcode a phone number in a test — phone uniqueness is global and this
  database is not reset between runs, so it passes once and fails forever after.
- Do not add a way to close a learning gap. It closes on evidence; that is the point.
- Do not hard-code a price or a limit. `can(organizationId, key)` reads the plan.
- Do not give `@updatedAt` a column without `@default(now())` — Prisma fills it and
  nothing else does, so a migration or a psql session hits a NOT NULL it cannot see.
- Do not import `@anthropic-ai/sdk` anywhere but `src/ai/anthropic.ts`, and do not
  call a provider outside `runTask` — model routing, budgets, scrubbing and the ledger
  are all bypassed at once.
- Do not put a timestamp, a request id or an unsorted list in a system prompt.
- Do not show a provider's error text to a user.
- Do not render a mastery estimate that `core/mastery` returned as INSUFFICIENT — the
  type has no field to read, and adding one would be undoing the guarantee.
- Do not write to `student_concept_mastery` outside `recomputeMastery`. It is a cache;
  a hand-written value cannot be reproduced from the ledger, which is the one property
  the two-table split exists for.
- Do not import `@anthropic-ai/sdk` outside `src/ai/` — model routing, budgets and PII
  scrubbing all live there, and a direct call bypasses the three at once.
- Do not reach an SMS provider outside `src/sms/`. `sendSms()` applies the daily
  ceiling, writes the ledger row a support call reads, and guarantees that a
  provider outage never throws on the sign-in path.
- Do not edit the wording in `src/sms/templates.ts` and ship it. India's DLT
  rules mean the operator matches the delivered text against a registered
  template; a changed word arrives nowhere, and nothing reports it.
- Do not add a single readiness score, an institute score, or any other
  composite. The pressure to add one arrives with every new surface and the
  answer is the same every time.
- Do not queue a webhook event outside the transaction that made the thing
  happen. That transaction IS the guarantee; an event emitted beside it is a
  claim that something occurred which may have rolled back.
- Do not put a phone number, an email or a student's own words in a webhook
  payload. The receiving MIS already knows its own students.
- Do not write `count === 1 ? one : other`. Hindi puts zero in the `one`
  category; use `Intl.PluralRules`.
- Do not have a test find a scarce shared row it needs to be in a particular
  state. This database is never reset. Author it.
- Do not add an `overflow-x: auto` container without `tabIndex={0}`, `role` and
  a label. axe only reports it once the content actually overflows, so it passes
  on your screen and fails on a phone — this has now been caught three times.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
