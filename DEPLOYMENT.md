# Deployment

## 1. Environments

| Environment | Purpose | Database | AI |
|---|---|---|---|
| `local` | Development | Docker Postgres, port **5433** | `MockProvider` by default |
| `preview` | Per-PR | Neon branch, seeded | Mock, unless the PR is labelled `ai-live` |
| `staging` | Pre-release, load tests | Own Neon project | Real, on a capped budget |
| `production` | Live | Neon, `ap-south-1` | Real |

Port 5433 for local Postgres because 5432 is usually taken by something else on a
developer's machine, and diagnosing "connected to the wrong database" costs a morning.

Preview environments use the mock provider by default. A pull request that silently
spends on generation is a pull request that will be opened fifty times a week.

## 2. Topology

| Component | Host | Notes |
|---|---|---|
| Next.js app | Vercel, `bom1` | Region matters: the database is in `ap-south-1` |
| Postgres | Neon, `ap-south-1` | Pooled + direct URLs |
| Worker | Fly.io, Mumbai | Long-lived process; queue + cron |
| Object storage | Cloudflare R2 | S3 API, no egress fee |
| Email | Resend | Transactional only |
| SMS / OTP | MSG91 | India-focused, DLT-registered |
| Errors | Sentry | Source maps uploaded, not served |
| Analytics | PostHog, self-hosted | Student behavioural data stays with us |

### Why a separate worker

Vercel functions cap out well below the 30–120 seconds an AI generation takes, and the
Hobby tier permits only a **daily** cron — it fails the deploy on anything faster. The
job drain must run every minute. So the worker is a small always-on process that polls
the queue and runs the scheduled sweeps. It is one more thing to operate, and it is the
right trade.

## 3. Database URLs — two, and it matters

```
DATABASE_URL   pooled,  port 6543, PgBouncer transaction mode   → the app
DIRECT_URL     direct,  port 5432                               → migrations only
```

Every managed Postgres this deploys on sits behind a transaction pooler. That is right
for the app — a serverless function opens a connection per invocation, and the pooler
is what stops that exhausting the database. It is wrong for migrations, which need
session state: advisory locks to serialise concurrent deploys, and
`CREATE TYPE` / `ALTER TABLE` inside one long-lived session. Run
`prisma migrate deploy` through the pooler and it fails partway with a lock or
prepared-statement error that names neither cause.

Locally the two are the same string, and that is fine.

**The pooler is also why tenant context must be transaction-local** — see
`SECURITY_MODEL.md` §2.

## 4. Environment variables

```
# Database
DATABASE_URL=            # pooled
DIRECT_URL=              # direct, migrations only

# Auth
# Nothing. Session tokens are random bytes stored as a hash — there is no secret
# to set and none to rotate. See SECURITY_MODEL.md section 6.

# SMS — without this, sign-in codes are issued and delivered nowhere, and no
# student can sign in. The boot check says so in the deploy log.
SMS_PROVIDER=            # none | log | msg91
SMS_API_KEY=
SMS_SENDER_ID=           # the registered six-letter header
SMS_TEMPLATE_LOGIN_CODE= # DLT template id; an unregistered message is dropped
SMS_TEMPLATE_PARENT_INVITE=
SMS_DAILY_CEILING=       # default 2000. Protects the bill, not a person.
# The DLT and MSG91 paperwork, step by step: docs/SMS_SETUP.md

# Question library — without the source, new schools start with an empty bank
QUESTION_LIBRARY_SOURCE=            # slug of the source organization, e.g. sirah-digital
QUESTION_LIBRARY_INCLUDE_EXEMPLAR=  # "true" ONLY after NCERT's written permission

# AI
ANTHROPIC_API_KEY=
AI_PROVIDER=anthropic|mock
AI_TIER_FAST=claude-haiku-4-5
AI_TIER_BALANCED=claude-sonnet-5
AI_TIER_DEEP=claude-opus-5
AI_MONTHLY_BUDGET_USD=
AI_TIMEOUT_MS=120000

# Storage
R2_ACCOUNT_ID= R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY= R2_BUCKET=
STORAGE_URL_SECRET=      # signed URL HMAC

# Messaging
RESEND_API_KEY=  MSG91_AUTH_KEY=  MSG91_TEMPLATE_ID=

# Jobs
CRON_SECRET=
WORKER_CONCURRENCY=4
JOB_LEASE_SECONDS=300

# Observability
SENTRY_DSN=  POSTHOG_KEY=  LOG_LEVEL=info

APP_URL=  NODE_ENV=
```

Model ids are environment variables, not constants in code. Re-tiering a feature is a
configuration change and an eval run — never a code deploy.

A missing required variable **fails at boot with the variable's name**, not at 2am
inside a request handler.

## 5. Migrations

```bash
npm run db:migrate      # dev: create + apply
npm run db:deploy       # prod: apply only
npm run db:rls          # apply hand-written RLS policies
npm run db:seed         # curriculum + demo tenant
```

RLS policies are hand-written SQL in `prisma/migrations/*/rls.sql`, applied after each
schema migration. Prisma cannot express them, and a policy that is not in version
control does not exist.

**Rules:**
- Migrations are forward-only in production. A rollback is a new migration.
- Every migration must be safe against the *previous* application version, because deploys are not atomic. Add a column, deploy, backfill, deploy the reader, then drop the old one — four steps, never one.
- No `DROP COLUMN` in the same release that stops writing it.
- A migration touching more than 100k rows runs as a job, not in the deploy step.

## 6. Deploy sequence

```
  1. CI green (TESTING.md §9)
  2. prisma migrate deploy   via DIRECT_URL, one at a time
  3. RLS policies applied
  4. Worker deployed         (it must understand the new schema first)
  5. App deployed            Vercel, atomic switch
  6. Smoke suite on production
  7. Watch error rate and p95 for 15 minutes
```

The worker goes before the app because it consumes jobs the app enqueues. Reverse the
order and the first minutes of a release produce jobs nothing can handle.

## 7. Backups and recovery

- Neon PITR, 7 days on staging, 30 on production.
- Nightly logical dump to R2, separate account, 90-day retention.
- **A restore is rehearsed quarterly into a scratch database and the row counts checked.** An unrehearsed backup is a belief, not a backup.

Targets: RPO 5 minutes, RTO 1 hour.

## 8. Monitoring

**Alert on** (these page someone):
- Attempt submit error rate > 1% over 5 minutes
- Attempt submit p95 > 1s
- Job queue depth > 500, or any job `DEAD`
- AI spend > 80% of monthly budget
- Database connections > 80% of the pool
- Any cross-tenant access attempt in the audit log
- Failed logins > 100/min

**Dashboard, not alerting:** signups, assessments created, attempts submitted, AI cost
per organization, generation approval rate.

**Generation approval rate is the health metric for the AI feature.** If it falls below
70%, generation is costing teachers time rather than saving it, and that is a product
outage even though nothing is throwing errors.

## 9. Scheduled work

| Job | Interval | Purpose |
|---|---|---|
| `drain-jobs` | 1 min | Process the queue |
| `sweep-attempts` | 5 min | Auto-submit abandoned attempts past expiry |
| `reap-leases` | 5 min | Return jobs from crashed workers |
| `classify-mistakes` | Nightly | Type the mistakes no rule could — see below |
| `recompute-gaps` | Hourly | Class-level aggregation |
| `purge-retention` | Daily | Delete past the retention window |
| `usage-rollup` | Daily | Billing counters |
| `share-library` | Every 5 minutes | Copies the question library into the next 5 CBSE schools waiting for it |

All run on the worker with `CRON_SECRET`, and each is independently runnable by hand
for debugging.

**`classify-mistakes` is the only one that spends money, and it is arranged not to.**
Most wrong answers never reach it: a blank, a paper the clock ended, a rushed answer
on a concept the student can demonstrably do, and any wrong true/false are all typed
by rule in `core/mistakes/classify.ts` — free, certain, and the majority. What is left
goes to a FAST-tier model in batches of 20 that share one cached system prefix.

The Anthropic **Batch API's further 50%** is not taken yet: it is asynchronous with a
turnaround measured in hours, so it needs a job that submits and a second that
collects, and the queue those belong in is not built. Nothing in the product needs a
mistake typed within the second, so this is the right next saving to take — the call
site is `src/core/mistakes/sync.ts` and the shape of the work does not change.

## 10. Scaling notes

Written down now so the first bad day is a lookup rather than a diagnosis.

| Symptom | First move |
|---|---|
| Analytics queries slow | Materialised views for class-level rollups, refreshed on submit |
| Connection exhaustion | Raise pooler size; check for a query outside `withTenant()` |
| Queue backing up | Raise `WORKER_CONCURRENCY`; then a second worker; only then Redis |
| AI cost spike | Per-org budget already caps it — inspect `ai_usage` by feature |
| A single large tenant | Read replica for their analytics before considering a dedicated database |

## 11. Launch gate

- [ ] Restore rehearsed and verified
- [ ] RLS audit passing in production
- [ ] Load test: 200 concurrent submissions inside 60s
- [ ] Alerts firing correctly (deliberately trip each one)
- [ ] Rollback rehearsed
- [ ] `.env` complete in every environment; boot-time validation on
- [ ] Security checklist in `SECURITY_MODEL.md` §11 complete
- [ ] Support runbook for the top five failure modes
- [ ] Status page live
