# Security Model

The product holds minors' academic records. The threat model is not "a hacker on the
internet" — it is a competing tuition centre in the same building, a parent who wants
another child's marks, and a student who wants the answer key.

## 1. Authentication

Built in-house. Sessions in Postgres, an opaque token in an HttpOnly cookie.

### Credentials by role

| Role | Method | Why |
|---|---|---|
| Teacher, admin | Email + password (argon2id) | They have email and use desktops |
| Student | Phone + OTP, or a class join code + a PIN set at first use | Many Class 9/10 students have no email of their own |
| Parent | Phone + OTP | Same, and the link is the point of entry |
| Platform admin | Email + password + mandatory TOTP | Cross-tenant reach |

Password rules: minimum 10 characters, checked against a breached-password list, no
composition rules, no forced rotation. Rotation policies produce `Summer2026!` and
nothing else.

### Session

```
  cookie: sid = <32 random bytes, base64url>
  db:     sessions.token_hash = sha256(sid)
```

The raw token is never stored, so a database dump is not a session-hijack kit.

Cookie flags: `HttpOnly; Secure; SameSite=Lax; Path=/`. Lifetime 30 days for students
(a school term should not log a child out mid-revision), 14 days for teachers, 8 hours
for platform admins. Sliding renewal, absolute cap at 90 days.

Rotated on privilege change, on organization switch, and on password change. All
sessions for a user are revocable, and revocation is immediate — the session row is
checked on every request, and it is one indexed lookup.

### OTP

6 digits, 5-minute expiry, single use, hashed at rest. Maximum 5 requests per phone per
hour and 5 verification attempts per code. On exhaustion, lock the phone number for 15
minutes and log it. Without both limits, OTP is an SMS-billing denial-of-service against
ourselves.

## 2. Authorization — three layers, all required

```
   Layer 1   Session       Who is asking, and for which organization
   Layer 2   Policy        May this role do this to this resource
   Layer 3   RLS           Postgres refuses rows outside the tenant regardless
```

Layer 3 exists because Layer 2 will be forgotten in some route, once, on a Friday.

### Layer 1 — Session

`getSession()` returns `{ userId, organizationId, membershipId, role }`. There is no
overload that accepts an org id, no `?orgId=` query parameter, and no `X-Org-Id`
header. If a user belongs to several organizations, they pick one at sign-in and it is
stored in the session row.

**The rule:** `organization_id` and `role` are never read from a request body, query
string or header. A prior specification for a similar product read the acting user out
of `req.body`; that is an impersonation hole with a friendly name.

### Layer 2 — Policy

Explicit, unit-tested predicates in `core/identity/authorize.ts`:

```
  can(actor, 'assessment:publish', assessment)
  can(actor, 'attempt:read', attempt)
  can(actor, 'student:read', student)
```

| Resource | Student | Teacher | Institute admin | Parent |
|---|---|---|---|---|
| Own attempt | read | — | — | — |
| Attempt in a class they teach | — | read, grade | read | — |
| Attempt of a linked child | — | — | — | read, **only when `RELEASED`** |
| Question (org) | — | read, write own; read org | read | — |
| Question answer key **during** an attempt | **never** | read | read | never |
| Assessment | read when assigned | full for own | read all | — |
| Mastery | own | own classes | all in org | linked child |
| Roster | own class only | own classes | all | — |
| Billing | — | — | full | — |

Two entries carry most of the risk. **The answer key is not sent to the client while an
attempt is in progress** — not hidden with CSS, not filtered in a component: absent
from the response payload. And **a parent reads only `RELEASED` results**, so a teacher
who has not finished marking is never contradicted by a notification.

### Layer 3 — RLS

Every tenant table has `enable row level security` **and** `force row level security`.
Without `force`, the application's own role owns the tables and bypasses every policy,
and the entire mechanism is decorative.

Tenant context is set transaction-locally:

```sql
select set_config('app.organization_id', $1, true);
```

The `true` is `is_local`. Under a transaction-mode pooler a session-level `SET` leaks
onto whichever request borrows the connection next — a cross-tenant read with no error
and no log line. There is one helper, `withTenant()`, and raw `prisma.$queryRaw` outside
it fails a CI check.

## 3. The test-integrity threat model

A student wants to pass. This is the one place where the user is the adversary, and
where being honest about the limits matters more than claiming to have solved it.

**What is enforced server-side, and cannot be bypassed by any client:**

| Control | Mechanism |
|---|---|
| The answer key | Never leaves the server during `IN_PROGRESS` |
| The clock | `started_at + duration_ms`, server-stamped; the client's clock is display only |
| Late submission | Rejected or marked, by server time |
| Duplicate submission | `client_attempt_id` unique key; a retry updates |
| Attempt limits | Checked against `assignments.max_attempts` |
| Question order | Shuffle seed derived server-side from `(attempt_id, secret)` |
| Score | Recomputed server-side; a client-sent score is discarded, not trusted |

**What is deterrence, and is labelled as deterrence:** tab-switch counting, paste
detection, full-screen prompts. These are recorded as signals on the attempt and shown
to the teacher as *"3 tab switches"* — never as *"cheating detected"*. A browser cannot
police a second device, and a product that claims otherwise is lying to a teacher who
will eventually act on it against a specific child.

**Not in scope, and stated plainly to customers:** a student with a phone beside the
laptop. High-stakes proctoring is a different product.

## 4. Input handling

- Every route body, query and param parsed by a Zod schema at the boundary. Reject; never coerce.
- Question content is Markdown, rendered through a sanitiser with an allow-list. A teacher pasting from Word must not be able to inject script into thirty students' browsers.
- File uploads: extension and magic-byte checked, size-capped, stored under a random key, served from a separate origin, `Content-Disposition: attachment` for anything that is not an image.
- Signed URLs expire in 15 minutes. **A signed URL is not authorisation** — the permission check happens when the URL is minted, and a URL for one org's file is never minted from another org's session.
- All queries are parameterised through Prisma. Raw SQL requires review and lives only in migrations and the tenant helper.

## 5. Rate limits

| Surface | Limit |
|---|---|
| Sign-in attempts | 10 per IP per 15 min; 5 per account per 15 min |
| OTP request | 5 per phone per hour |
| API, authenticated | 300 req/min per user |
| AI generation | Per-plan entitlement + 10 concurrent per org |
| Attempt autosave | 120/min per attempt (generous — never throttle a student mid-exam) |
| Bulk import | 3 per hour per org |
| Public endpoints | 30/min per IP |

Autosave is deliberately loose. Throttling a student's answer sync to protect the
server is trading a real academic outcome for a synthetic one.

## 6. Secrets

Environment variables only, injected by the platform. No secret in the repository, no
secret in a `NEXT_PUBLIC_` variable, no AI provider key reachable from the browser —
every model call goes through our server.

`.env.example` lists every key with a description and no value. A missing required
variable fails at boot, loudly, rather than at 2am inside a request —
`src/config/environment.ts`, called from `instrumentation.ts`, which Next runs
once before the server takes a request.

It distinguishes two things that look alike. A capability that is legitimately
off — no AI key, no cron secret — is reported and never fatal, because refusing
to boot over a missing AI key would make the product undeployable for anybody
not paying for AI. A configuration that CONTRADICTS ITSELF is fatal in
production: `SMS_PROVIDER=msg91` with no API key is not "SMS is off", it is
somebody who meant to turn SMS on and mistyped, and falling back silently would
hide that behind a deployment that looks fine and cannot sign anybody in.

Rotation: quarterly for provider keys, immediately on staff departure.

**There is no session secret to rotate, and that is stronger rather than
weaker.** A session token is 32 random bytes stored as a SHA-256 hash and looked
up by it: opaque, carrying no claims, so there is nothing to sign. Revoking a
session is deleting a row, which takes effect immediately — where a signed token
stays valid until it expires, whatever the server has since decided about it.
This document previously described a two-secret rotation that did not exist in
the code; an operator who rotated it believing everyone would be signed out
would have changed nothing at all.

## 7. Audit logging

Append-only. `UPDATE` and `DELETE` raise from a trigger.

Logged: sign-in and failure, role change, invitation, assessment publish, assignment,
grade override (with before and after), result release, data export, parent link grant
and revoke, subscription change, every platform-admin action, and every cross-tenant
read.

Each entry carries actor, role, organization, entity, before/after, IP, user agent and
request id. Retained 24 months.

When a parent disputes a mark, the answer is a reconstructable history — not a
recollection.

## 8. Data protection

**Minimisation.** A student record needs a name, a class and a guardian contact. Not an
address, not a date of birth, not a photograph. Fields are added when a customer can
name the feature that needs them.

**Retention.** Attempts and mastery for the academic year plus two years. Sessions 90
days. AI generation records 12 months. Audit logs 24 months. Deletion is a scheduled
purge, not a manual script someone remembers to run.

**Export and deletion.** An organization can export everything it owns as JSON plus
CSV. A deletion request removes personal data and retains anonymised aggregates, which
is stated in the terms rather than discovered later.

**Children's data.** Students are 13–16. Parent linking requires explicit recorded
consent. A student's tutor conversations and mistake-bank contents are **not** in the
parent scope — a child who believes a parent reads every question they ask stops asking
questions, which destroys the feature's value and the child's interest at once. Marketing
communication is never sent to a student account.

**Region.** Data resides in India (`ap-south-1`), which is both a real compliance
posture under the DPDP Act and the first question every school asks.

**Voice input, stated precisely rather than flatteringly.** Dictation on a written
answer uses the browser's own Web Speech API. No audio and no transcript ever
reaches a Sahayak server or an AI provider, and there is no route that would
accept one — which is the property that matters and the reason a cloud speech
vendor was not used. It is NOT true that nothing leaves the device: Chrome's
`webkitSpeechRecognition` performs recognition on Google's servers. That is the
browser's own relationship with its user, under a permission the user granted
their browser rather than us, and it is materially different from us choosing a
processor for a child's voice. But it is a disclosure, not a footnote, and a
school asking where a recording goes deserves this paragraph rather than the
shorter sentence. `src/ui/VoiceInput.tsx` says the same thing at the point of
use.

**Webhook payloads carry no contact details and no student's own words.** An MIS
receives ids, marks and how many marks are still outstanding. It already knows
its own students' names and numbers; sending them again would put personal data
on a wire we do not control in order to tell somebody what they already have.
The selection is an allow-list, so a field added later goes missing from a
payload — visible, and fixable — rather than being sent.

## 9. Transport and headers

TLS 1.3, HSTS with preload. Content-Security-Policy with no `unsafe-inline` (nonces for
the few inline scripts Next requires). `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying
camera, microphone and geolocation.

CSRF: `SameSite=Lax` plus an origin check on every state-changing request. Uploads go
to a separate origin so a stored file can never execute as first-party script.

## 10. The cron surface

`/api/cron/*` is the only route with no session, because a scheduler is not a person.

It is gated by `CRON_SECRET` as a bearer token, compared in constant time. It may only
touch work that no individual owns — the abandoned-attempt sweep, the job-lease
reaper, the retention purge, the nightly batch classification. It can never act as a
user, and it is rate-limited like everything else.

## 11. Pre-launch checklist

- [ ] Every tenant table has RLS enabled **and** forced — verified by a test that enumerates `information_schema`, not by reading the migration
- [ ] A cross-tenant read test exists for every resource type and fails loudly
- [ ] Answer keys absent from every `IN_PROGRESS` payload — asserted in an E2E test against the wire response
- [ ] A parent cannot reach an unreleased result, or any unlinked student
- [ ] A student cannot reach another student's attempt by id
- [ ] Rate limits verified under load, not by reading configuration
- [ ] No secret in the client bundle — grep the build output in CI
- [ ] Dependency audit clean; `npm audit` in CI
- [ ] Backups restored into a scratch database and verified, at least once, before launch
- [ ] Audit log write path tested for the twelve events above
