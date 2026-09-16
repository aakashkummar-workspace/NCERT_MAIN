-- Row-level security policies.
--
-- Prisma cannot express these, so they are hand-written and applied by
-- `npm run db:rls` after every schema migration. Idempotent: safe to re-run.
--
-- RLS is the SECOND line of defence, not the first. Application code still
-- filters by organization_id explicitly and still checks roles. RLS exists so
-- that the day someone forgets a WHERE clause is a non-event rather than a
-- breach notification.
--
-- See SECURITY_MODEL.md section 2 and DATABASE_SCHEMA.md section 12.
--
-- ===========================================================================
-- THE THING MOST LIKELY TO MAKE ALL OF THIS USELESS
-- ===========================================================================
-- A superuser bypasses row-level security unconditionally, and so does any role
-- with BYPASSRLS. If the application connects as the Postgres superuser — which
-- is the default in every Docker quickstart — then every policy below is inert
-- and the cross-tenant test passes while proving nothing.
--
-- So: the app and the test suite connect as `sahayak_app`, a plain LOGIN role
-- with no superuser and no BYPASSRLS. Migrations connect as the superuser via
-- DIRECT_URL. scripts/audit-rls.ts asserts this separation rather than assuming
-- it.

-- ---------------------------------------------------------------------------
-- The application role
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sahayak_app') then
    -- Password is replaced from the environment by scripts/apply-rls.ts.
    create role sahayak_app login password 'sahayak_dev_password';
  end if;
end $$;

-- Only when the role actually holds one of these attributes. On Supabase the
-- `postgres` user is not a superuser, and supautils refuses even a NOSUPERUSER
-- that changes nothing; a role this file creates never has any of them.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'sahayak_app'
             and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole)) then
    alter role sahayak_app nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end $$;

grant usage on schema public to sahayak_app;
grant select, insert, update, delete on all tables in schema public to sahayak_app;
grant usage, select on all sequences in schema public to sahayak_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to sahayak_app;
alter default privileges in schema public
  grant usage, select on sequences to sahayak_app;

-- ---------------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------------

-- Reads the tenant set for the CURRENT TRANSACTION.
--
-- current_setting(..., true) returns NULL rather than raising when the setting
-- is absent, which is what we want: no context means no rows, not an error a
-- caller might catch and paper over.
create or replace function app_current_org() returns uuid
  language sql stable
as $$
  select nullif(current_setting('app.organization_id', true), '')::uuid
$$;

grant execute on function app_current_org() to sahayak_app;

-- ---------------------------------------------------------------------------
-- Audit log immutability
-- ---------------------------------------------------------------------------

create or replace function app_audit_immutable() returns trigger
  language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only (attempted %)', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists audit_logs_no_update on audit_logs;
create trigger audit_logs_no_update
  before update on audit_logs
  for each row execute function app_audit_immutable();

drop trigger if exists audit_logs_no_delete on audit_logs;
create trigger audit_logs_no_delete
  before delete on audit_logs
  for each row execute function app_audit_immutable();

-- ---------------------------------------------------------------------------
-- Tenant-plane policies
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  tenant_tables text[] := array[
    'memberships', 'sessions', 'invitations',
    'classes', 'class_teachers', 'class_enrolments',
    'student_profiles', 'teacher_profiles',
    'assessments', 'assessment_questions',
    'assignments', 'assignment_targets',
    'attempts', 'attempt_answers',
    -- Slice 9. The ledger and the estimate are ordinary tenant tables: a
    -- student's evidence belongs to the organization that taught them, and the
    -- fact that concepts are global does not make the evidence global.
    'concept_evidence', 'student_concept_mastery',
    -- Slice 11. ai_budgets is a plain tenant table; the two ledgers below
    -- carry a NULLABLE organization_id and are handled separately.
    'ai_budgets',
    -- Slice 12.
    'learning_gaps', 'interventions',
    -- The Mistake Bank. A student's own wrong answers: tenant-scoped like
    -- every other piece of their work, and deliberately outside the parent's
    -- read scope — see SECURITY_MODEL.md.
    'student_mistakes',
    -- Personalised practice. `practice_answers` carries its own organization_id
    -- rather than resolving through the session: a policy that joins is a
    -- policy that runs on every row read, and this table is written one answer
    -- at a time while a student works.
    'practice_sessions', 'practice_answers',
    -- The parent portal. The link is the ONLY thing that grants a parent any
    -- read at all, so it is tenant-scoped like everything else and the reader
    -- checks consent and revocation on top of that — RLS answers "same
    -- organization", never "may this parent see this child".
    'parent_student_links',
    -- The Copilot. Conversations are a teacher's own, and the reader scopes to
    -- their user id on top of the tenant policy: a colleague in the same
    -- organization has no business reading what somebody asked about a class.
    'copilot_conversations', 'copilot_messages',
    -- The tutor. A student's own, scoped to their user id on top of the tenant
    -- policy — and outside the parent scope entirely, which the ESLint fence
    -- over the parent surface enforces rather than this policy.
    'tutor_sessions', 'tutor_turns',
    -- Reports. A stamped document about one child, readable by their teacher
    -- and — through core/parent/read.ts and nothing else — by a linked parent.
    -- Tenant-scoped like everything else; consent is checked on top of it.
    'reports',
    -- Billing. `subscriptions` and `usage_counters` are per-organization;
    -- `plans` and `entitlements` are platform property, below.
    'subscriptions', 'usage_counters',
    -- MIS/ERP webhooks. All three are ordinary tenant tables and none of them
    -- is an exception: an endpoint is a school's own configuration, an outbox
    -- row describes something that happened inside one school, and a job
    -- carries the ids of both. The cron runner does NOT get a privileged
    -- connection to work around this — it asks which tenants have work and
    -- then works inside withTenant() like everything else, which is why
    -- `app_maint_orgs_with_webhook_work` further down returns ids and nothing
    -- else.
    'webhook_endpoints', 'outbox', 'jobs',
    -- The student dashboard. An announcement is a teacher's message to one
    -- class; a saved question is one student's own bookmark. Both ordinary
    -- tenant tables; "which class" and "whose" are checked on top.
    'announcements', 'saved_questions',
    -- Teacher-assigned practice. One teachers instruction to one class, and
    -- an ordinary tenant table: which class is checked on top, as everywhere.
    'assigned_practice',
    -- White labelling. A school's own presentation and its uploaded logos —
    -- ordinary tenant tables. The branded sign-in page reads them before any
    -- tenant is known, and does so through `app_public_branding` below rather
    -- than through an exception here.
    'organization_branding', 'organization_logos'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    -- FORCE applies policies to the table owner too. The app is not the owner
    -- here, so this is belt-and-braces — but it is the brace that holds if
    -- ownership ever changes.
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I
         using (organization_id = app_current_org())
         with check (organization_id = app_current_org())', t);
  end loop;
end $$;

-- organizations: a member sees only their own organization row.
alter table organizations enable row level security;
alter table organizations force row level security;
drop policy if exists tenant_isolation on organizations;
create policy tenant_isolation on organizations
  using (id = app_current_org())
  with check (id = app_current_org());

-- audit_logs: append-only, and a NULL organization_id marks a cross-tenant
-- platform action. A tenant may read its own rows and write only its own;
-- the NULL rows are visible to the platform role alone.
alter table audit_logs enable row level security;
alter table audit_logs force row level security;
drop policy if exists tenant_isolation on audit_logs;
create policy tenant_isolation on audit_logs
  using (organization_id = app_current_org())
  with check (organization_id = app_current_org());

-- users: global identity, so this is the one table whose policy is a join
-- rather than a column comparison. A user row is visible when the current
-- tenant has a membership for them.
--
-- The policy is split by command, and the reason is not cosmetic. Adding a
-- student creates a user row and THEN a membership; a single FOR ALL policy
-- would evaluate the membership test on the INSERT, when no membership exists
-- yet, and the insert would fail. So INSERT is permitted outright: a user row
-- with no membership is invisible to every tenant, unreachable by every query
-- here, and cannot be turned into access without a membership row — and THAT
-- insert is tenant-checked.
--
-- Note that Postgres applies the SELECT policy to an INSERT ... RETURNING, so
-- roster code inserts without RETURNING and reads back after the membership
-- exists. src/core/roster/add.ts carries the same note.
alter table users enable row level security;
alter table users force row level security;

drop policy if exists tenant_visibility on users;
drop policy if exists user_select on users;
drop policy if exists user_insert on users;
drop policy if exists user_modify on users;
drop policy if exists user_delete on users;

create policy user_select on users for select
  using (
    exists (
      select 1 from memberships m
      where m.user_id = users.id
        and m.organization_id = app_current_org()
    )
  );

create policy user_insert on users for insert
  with check (true);

create policy user_modify on users for update
  using (
    exists (
      select 1 from memberships m
      where m.user_id = users.id
        and m.organization_id = app_current_org()
    )
  )
  with check (
    exists (
      select 1 from memberships m
      where m.user_id = users.id
        and m.organization_id = app_current_org()
    )
  );

create policy user_delete on users for delete
  using (
    exists (
      select 1 from memberships m
      where m.user_id = users.id
        and m.organization_id = app_current_org()
    )
  );

-- ---------------------------------------------------------------------------
-- Curriculum plane — global, platform-owned, readable by every tenant
-- ---------------------------------------------------------------------------
--
-- These tables carry no organization_id, so their policy cannot be tenant-
-- scoped and must not pretend to be. They are readable by everyone and writable
-- by nobody through the app role: the platform seeds them over DIRECT_URL.
--
-- That asymmetry is the point of the two-plane model. If each tenant could
-- write its own subjects, "Mathematics" would be a different row in every
-- organization and there would be no cross-tenant intelligence to build later.

do $$
declare
  t text;
  curriculum_tables text[] := array[
    'boards', 'grades', 'subjects',
    'chapters', 'topics', 'learning_outcomes',
    'concepts', 'concept_outcomes', 'concept_prerequisites'
  ];
begin
  foreach t in array curriculum_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists curriculum_readable on %I', t);
    execute format('create policy curriculum_readable on %I for select using (true)', t);
  end loop;
end $$;

-- Read-only to the app role. No insert, update or delete grant, so a bug in
-- feature code cannot rewrite the shared curriculum for every customer.
revoke insert, update, delete on
  boards, grades, subjects,
  chapters, topics, learning_outcomes,
  concepts, concept_outcomes, concept_prerequisites
from sahayak_app;

-- ---------------------------------------------------------------------------
-- The platform role
-- ---------------------------------------------------------------------------
--
-- Someone has to be able to author curriculum, and it is not a tenant. Rather
-- than punch a SECURITY DEFINER hole that any authenticated request could reach
-- if an authorization check were ever forgotten, curriculum writes run as a
-- SEPARATE ROLE with its own connection.
--
-- The defence is then structural rather than procedural: a teacher-facing route
-- physically cannot write curriculum, because the connection it holds has no
-- grant to do so. The role check in application code becomes the second line
-- instead of the only one.
--
-- Still no BYPASSRLS: the write policies below are scoped TO this role, so
-- Postgres is what distinguishes it, not a flag that would also disable tenant
-- isolation everywhere else.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sahayak_platform') then
    create role sahayak_platform login password 'sahayak_platform_password';
  end if;
end $$;

-- Only when the role actually holds one of these attributes. On Supabase the
-- `postgres` user is not a superuser, and supautils refuses even a NOSUPERUSER
-- that changes nothing; a role this file creates never has any of them.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'sahayak_platform'
             and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole)) then
    alter role sahayak_platform nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end $$;

grant usage on schema public to sahayak_platform;
grant select, insert, update, delete on all tables in schema public to sahayak_platform;
grant usage, select on all sequences in schema public to sahayak_platform;
alter default privileges in schema public
  grant select, insert, update, delete on tables to sahayak_platform;
grant execute on function app_current_org() to sahayak_platform;

do $$
declare
  t text;
  curriculum_tables text[] := array[
    'boards', 'grades', 'subjects',
    'chapters', 'topics', 'learning_outcomes',
    'concepts', 'concept_outcomes', 'concept_prerequisites'
  ];
begin
  foreach t in array curriculum_tables loop
    execute format('drop policy if exists curriculum_write on %I', t);
    -- Scoped TO sahayak_platform: sahayak_app does not match the role, so this
    -- policy grants it nothing even if a grant were restored by accident.
    execute format(
      'create policy curriculum_write on %I for all to sahayak_platform
         using (true) with check (true)', t);
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- Questions: the one entity that spans both planes
-- ---------------------------------------------------------------------------
--
-- A GLOBAL question is platform-owned and readable by every tenant; an
-- ORGANIZATION or PRIVATE one belongs to exactly one. So the read policy is
-- wider than the write policy, and the two are separate on purpose:
--
--   read  : organization_id is null OR organization_id = current tenant
--   write : organization_id = current tenant
--
-- The write policy's WITH CHECK is what stops a tenant creating a GLOBAL
-- question — organization_id NULL fails the comparison — so nobody can publish
-- into every other customer's bank by setting a field.


-- Enforced by the database, not by convention: a question is GLOBAL exactly
-- when it has no organization.
alter table questions drop constraint if exists questions_global_has_no_org;
alter table questions add constraint questions_global_has_no_org
  check ((visibility = 'GLOBAL') = (organization_id is null));

alter table questions enable row level security;
alter table questions force row level security;

drop policy if exists question_read on questions;
create policy question_read on questions for select
  using (organization_id is null or organization_id = app_current_org());

drop policy if exists question_write on questions;
create policy question_write on questions for insert
  with check (organization_id = app_current_org());

drop policy if exists question_modify on questions;
create policy question_modify on questions for update
  using (organization_id = app_current_org())
  with check (organization_id = app_current_org());

drop policy if exists question_delete on questions;
create policy question_delete on questions for delete
  using (organization_id = app_current_org());

-- Versions and outcome links have no organization_id of their own: they belong
-- to whatever the question belongs to. Scoping them by a join keeps one source
-- of truth rather than a denormalised column that can disagree with it.
do $$
declare
  t text;
  child_tables text[] := array['question_versions', 'question_outcomes'];
begin
  foreach t in array child_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists question_child_read on %I', t);
    execute format(
      'create policy question_child_read on %I for select
         using (exists (
           select 1 from questions q
           where q.id = %I.question_id
             and (q.organization_id is null or q.organization_id = app_current_org())
         ))', t, t);
    execute format('drop policy if exists question_child_write on %I', t);
    execute format(
      'create policy question_child_write on %I for all
         using (exists (
           select 1 from questions q
           where q.id = %I.question_id and q.organization_id = app_current_org()
         ))
         with check (exists (
           select 1 from questions q
           where q.id = %I.question_id and q.organization_id = app_current_org()
         ))', t, t, t);
  end loop;
end $$;

-- The platform curates the GLOBAL bank, on its own role, as with curriculum.
do $$
declare
  t text;
  question_tables text[] := array['questions', 'question_versions', 'question_outcomes'];
begin
  foreach t in array question_tables loop
    execute format('drop policy if exists question_platform on %I', t);
    execute format(
      'create policy question_platform on %I for all to sahayak_platform
         using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The pre-tenant seam
-- ---------------------------------------------------------------------------
-- Sign-in has a genuine ordering problem: you cannot scope a lookup by an
-- organization the caller has not yet proved membership of. Rather than
-- weakening the policies above, the three reads that must happen before a
-- tenant is known are SECURITY DEFINER functions with a narrow, fixed shape.
--
-- They take an exact identifier and return at most one user's auth columns.
-- They cannot enumerate, cannot filter, cannot project anything else, and are
-- the ONLY sanctioned pre-tenant reads in the system. src/db/unscoped.ts is the
-- only module allowed to call them, and an ESLint rule enforces that.

create or replace function app_auth_find_user(p_identifier text)
  returns table (
    id            uuid,
    password_hash text,
    status        text,
    full_name     text
  )
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select u.id, u.password_hash, u.status::text, u.full_name
  from users u
  where u.deleted_at is null
    and (lower(u.email) = lower(p_identifier) or u.phone = p_identifier)
  limit 1
$$;

create or replace function app_auth_identifier_taken(p_email text, p_phone text)
  returns boolean
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select exists (
    select 1 from users u
    where u.deleted_at is null
      and (
        (p_email is not null and lower(u.email) = lower(p_email))
        or (p_phone is not null and u.phone = p_phone)
      )
  )
$$;

create or replace function app_auth_list_memberships(p_user_id uuid)
  returns table (
    membership_id     uuid,
    organization_id   uuid,
    organization_name text,
    organization_slug text,
    role              text,
    status            text
  )
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select m.id, o.id, o.name, o.slug, m.role::text, m.status::text
  from memberships m
  join organizations o on o.id = m.organization_id
  where m.user_id = p_user_id
    and m.status = 'ACTIVE'
    and m.left_at is null
    and o.deleted_at is null
  order by m.created_at asc
$$;

-- Resolving a session token is also pre-tenant: the token is what TELLS us the
-- tenant. Same narrow shape — an exact hash in, one row out.
drop function if exists app_auth_resolve_session(bytea);
create function app_auth_resolve_session(p_token_hash bytea)
  returns table (
    session_id        uuid,
    user_id           uuid,
    organization_id   uuid,
    membership_id     uuid,
    role              text,
    expires_at        timestamptz,
    full_name         text,
    organization_name text,
    platform_admin    boolean,
    locale            text
  )
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  -- `locale` joined the fixed column list so a stored language preference can
  -- outrank the browser's header (CLAUDE.md, Internationalisation). It is a
  -- display preference, not an auth column, and nothing else was added.
  select s.id, s.user_id, s.organization_id, s.membership_id,
         m.role::text, s.expires_at, u.full_name, o.name, u.platform_admin, u.locale
  from sessions s
  join memberships m on m.id = s.membership_id
  join users u on u.id = s.user_id
  join organizations o on o.id = s.organization_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > now()
    and m.status = 'ACTIVE'
    and u.status = 'ACTIVE'
    and u.deleted_at is null
    and o.deleted_at is null
  limit 1
$$;

-- An invitation is opened by somebody with no session at all, which is the same
-- ordering problem sign-in has: the token is what tells us the tenant, so
-- resolving it cannot already be inside one. Answered the same way — an exact
-- token hash in, at most one row of the narrowest useful shape out.
--
-- What it deliberately does NOT return: anything about the child's work. This
-- resolves an unauthenticated URL, so it carries only what a parent needs to
-- recognise the link is theirs.
create or replace function app_auth_invitation(p_token_hash bytea, p_now timestamptz)
  returns table (
    organization_id   uuid,
    organization_name text,
    student_user_id   uuid,
    student_name      text,
    relationship      text,
    phone             text
  )
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select i.organization_id, o.name, i.student_user_id, u.full_name,
         i.relationship::text, i.phone
  from invitations i
  join organizations o on o.id = i.organization_id
  join users u on u.id = i.student_user_id
  where i.token_hash = p_token_hash
    and i.role = 'PARENT'
    -- An invitation works ONCE. Without this a parent whose access was revoked
    -- could reopen the link they were sent in the first place and consent
    -- again, which turned revocation into a request the parent could overrule.
    and i.accepted_at is null
    and i.revoked_at is null
    and i.expires_at > p_now
    and i.student_user_id is not null
    and i.phone is not null
    and o.deleted_at is null
    and u.deleted_at is null
  limit 1
$$;

-- A STAFF invitation, opened the same way by somebody with no session in this
-- organization — often with no account at all. The seventh pre-tenant read,
-- and the same shape: an exact token hash in, at most one row out.
--
-- It returns the address the invitation was sent to so the acceptance can
-- insist the account joining is that address, and the organization's name so
-- the invitee can recognise it. Nothing else about the organization — not its
-- classes, not its staff, not who sent it.
create or replace function app_auth_staff_invitation(p_token_hash bytea, p_now timestamptz)
  returns table (
    invitation_id     uuid,
    organization_id   uuid,
    organization_name text,
    email             text,
    role              text
  )
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select i.id, i.organization_id, o.name, i.email, i.role::text
  from invitations i
  join organizations o on o.id = i.organization_id
  where i.token_hash = p_token_hash
    and i.role in ('OWNER', 'ADMIN', 'TEACHER')
    and i.accepted_at is null
    and i.revoked_at is null
    and i.expires_at > p_now
    and i.email is not null
    and o.deleted_at is null
  limit 1
$$;

revoke all on function app_auth_staff_invitation(bytea, timestamptz) from public;
grant execute on function app_auth_staff_invitation(bytea, timestamptz) to sahayak_app;

-- ---------------------------------------------------------------------------
-- A school's branded sign-in page
-- ---------------------------------------------------------------------------
-- `/school/<slug>` shows a school's name and logo to somebody who has not signed
-- in, which is sign-in's ordering problem once more: the page exists to be seen
-- BEFORE a session names the tenant. Answered the same way — an exact slug in,
-- at most one row out, and only the columns the page draws.
--
-- What it deliberately does NOT return: the organization's id, its address,
-- its affiliation number, its principal's name, or anything else from the
-- branding row. Those go on a report, which is read inside a tenant. A sign-in
-- page is public, and public is the narrowest shape available.
--
-- Nor does it answer for a school whose plan does not include `white_label`.
-- The entitlement is decided here, in SQL, because the caller has no tenant to
-- ask `can()` with. That makes this a second statement of the rule in
-- core/billing/entitlements.ts — a subscription counts only when ACTIVE or
-- TRIALING, and anything else falls back to the plan coded `free` — and
-- tests/integration/branding.test.ts holds the two against each other so they
-- cannot drift apart unnoticed.
create or replace function app_branding_entitled(p_organization_id uuid)
  returns boolean
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select exists (
    select 1
    from entitlements e
    where e.key = 'white_label'
      and (e.unlimited or e.limit_value > 0)
      and e.plan_id = coalesce(
        (select s.plan_id from subscriptions s
          where s.organization_id = p_organization_id
            and s.status::text in ('ACTIVE', 'TRIALING')
          limit 1),
        (select p.id from plans p where p.code = 'free')
      )
  )
$$;

-- Not granted to the app role. It is a building block for the two reads below,
-- not a way to ask about an arbitrary organization id.
revoke all on function app_branding_entitled(uuid) from public;

create or replace function app_public_branding(p_slug text)
  returns table (
    organization_name text,
    display_name      text,
    short_name        text,
    tagline           text,
    logo_id           uuid,
    theme             jsonb,
    website           text,
    hide_powered_by   boolean
  )
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select o.name, b.display_name, b.short_name, b.tagline, b.logo_id,
         b.theme, b.website, b.hide_powered_by
  from organizations o
  join organization_branding b on b.organization_id = o.id
  where o.slug = p_slug
    and o.deleted_at is null
    and app_branding_entitled(o.id)
  limit 1
$$;

-- The logo the public page shows, and only the CURRENT one. A superseded logo
-- is still reachable by a signed-in member through a stamped report; it has no
-- business being fetchable by anybody who guesses an id.
create or replace function app_public_logo(p_slug text, p_logo_id uuid)
  returns table (mime text, bytes bytea)
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select l.mime, l.bytes
  from organizations o
  join organization_branding b on b.organization_id = o.id
  join organization_logos l on l.id = b.logo_id and l.organization_id = o.id
  where o.slug = p_slug
    and l.id = p_logo_id
    and o.deleted_at is null
    and app_branding_entitled(o.id)
  limit 1
$$;

revoke all on function app_public_branding(text) from public;
revoke all on function app_public_logo(text, uuid) from public;
grant execute on function app_public_branding(text) to sahayak_app;
grant execute on function app_public_logo(text, uuid) to sahayak_app;

revoke all on function app_auth_find_user(text) from public;
revoke all on function app_auth_identifier_taken(text, text) from public;
revoke all on function app_auth_list_memberships(uuid) from public;
revoke all on function app_auth_resolve_session(bytea) from public;

revoke all on function app_auth_invitation(bytea, timestamptz) from public;

grant execute on function app_auth_find_user(text) to sahayak_app;
grant execute on function app_auth_invitation(bytea, timestamptz) to sahayak_app;
grant execute on function app_auth_identifier_taken(text, text) to sahayak_app;
grant execute on function app_auth_list_memberships(uuid) to sahayak_app;
grant execute on function app_auth_resolve_session(bytea) to sahayak_app;

-- Signup creates an organization, a user and a membership before any of the
-- three exists to grant context. It is one transaction, SECURITY DEFINER, and
-- returns the ids the caller then uses under a normal tenant-scoped session.
--
-- The slug is made unique HERE rather than by the caller, because a caller
-- cannot do it correctly: `organizations` is behind an RLS policy keyed on the
-- current tenant, so a pre-tenant "is this slug free?" query sees no rows and
-- always answers yes. Two centres with the same name then collide on the unique
-- index. Doing it inside the insert loop also removes the check-then-insert
-- race, which a separate query would have anyway.
-- The board arrives as a parameter, so the six-argument shape is gone. Left
-- behind it would be a second door into signup that creates an organization
-- with no board — and the column is NOT NULL precisely so that cannot happen.
drop function if exists app_auth_bootstrap_org(text, text, text, text, text, text);

create or replace function app_auth_bootstrap_org(
  p_org_name  text,
  p_org_slug  text,
  p_org_type  text,
  p_board_id  uuid,
  p_email     text,
  p_password  text,
  p_full_name text
)
  returns table (organization_id uuid, user_id uuid, membership_id uuid)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_mem  uuid;
  v_slug text := p_org_slug;
begin
  for attempt in 0..20 loop
    begin
      insert into organizations (id, name, slug, type, board_id, status, updated_at)
      values (gen_random_uuid(), p_org_name, v_slug,
              p_org_type::"OrganizationType", p_board_id, 'TRIAL', now())
      returning id into v_org;
      exit;
    exception when unique_violation then
      v_slug := p_org_slug || '-' || substr(md5(random()::text), 1, 5);
    end;
  end loop;

  if v_org is null then
    raise exception 'could not allocate a unique slug for %', p_org_slug;
  end if;

  insert into users (id, email, password_hash, full_name, status, updated_at)
  values (gen_random_uuid(), lower(p_email), p_password, p_full_name, 'ACTIVE', now())
  returning id into v_user;

  insert into memberships (id, organization_id, user_id, role, status, joined_at, updated_at)
  values (gen_random_uuid(), v_org, v_user, 'OWNER', 'ACTIVE', now(), now())
  returning id into v_mem;

  return query select v_org, v_user, v_mem;
end;
$$;

revoke all on function app_auth_bootstrap_org(text, text, text, uuid, text, text, text) from public;
grant execute on function app_auth_bootstrap_org(text, text, text, uuid, text, text, text) to sahayak_app;

-- ---------------------------------------------------------------------------
-- login_codes: pre-tenant, and readable by nobody
-- ---------------------------------------------------------------------------
--
-- A student signing in has no organization yet, so this table cannot be
-- tenant-scoped. It is reached ONLY through the SECURITY DEFINER functions
-- below; the app role has a policy that matches nothing, so a bug in feature
-- code cannot read a code out of it.

alter table login_codes enable row level security;
alter table login_codes force row level security;

drop policy if exists login_codes_denied on login_codes;
create policy login_codes_denied on login_codes for all using (false) with check (false);

revoke select, insert, update, delete on login_codes from sahayak_app;

-- Issue a code. Rate limited HERE rather than in application code, because the
-- limit protects an SMS bill and must hold even if a route forgets to check.
create or replace function app_auth_issue_code(
  p_phone text,
  p_code_hash bytea,
  p_expires_at timestamptz
)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  recent int;
begin
  select count(*) into recent
  from login_codes
  where phone = p_phone and created_at > now() - interval '1 hour';

  -- Five an hour. Without this, the sign-in form is a denial-of-service
  -- against our own SMS spend.
  if recent >= 5 then
    return false;
  end if;

  insert into login_codes (id, phone, code_hash, expires_at)
  values (gen_random_uuid(), p_phone, p_code_hash, p_expires_at);

  return true;
end;
$$;

-- Verify a code and return the student it belongs to.
--
-- Single use, attempt-limited, and it consumes the code whether or not the
-- code matched — five wrong guesses burn it, so a six-digit code cannot be
-- brute-forced inside its five-minute life.
create or replace function app_auth_consume_code(p_phone text, p_code_hash bytea)
  returns table (user_id uuid, full_name text)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_code login_codes%rowtype;
begin
  select * into v_code
  from login_codes
  where phone = p_phone
    and consumed_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  if not found then
    return;
  end if;

  update login_codes set attempts = attempts + 1 where id = v_code.id;

  if v_code.attempts + 1 >= 5 then
    update login_codes set consumed_at = now() where id = v_code.id;
  end if;

  if v_code.code_hash <> p_code_hash then
    return;
  end if;

  update login_codes set consumed_at = now() where id = v_code.id;

  return query
    select u.id, u.full_name
    from users u
    where u.phone = p_phone and u.deleted_at is null and u.status = 'ACTIVE'
    limit 1;
end;
$$;

-- Verify a code WITHOUT requiring an account to exist.
--
-- `app_auth_consume_code` above answers "which user does this code belong to",
-- and returns nothing when there is no user — which is right for a student, who
-- was put on a roster before they ever signed in, but wrong for a parent, who
-- has no account at all until they accept an invitation. Using it there would
-- make a correct code from a new parent indistinguishable from a wrong one.
--
-- So this one answers the narrower question: was the code right? It consumes
-- and counts attempts exactly as the other does, so a code is still single-use
-- and still locks out after five tries.
create or replace function app_auth_verify_code(p_phone text, p_code_hash bytea)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_code login_codes%rowtype;
begin
  select * into v_code
  from login_codes
  where phone = p_phone
    and consumed_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  if not found then
    return false;
  end if;

  update login_codes set attempts = attempts + 1 where id = v_code.id;

  if v_code.attempts + 1 >= 5 then
    update login_codes set consumed_at = now() where id = v_code.id;
  end if;

  if v_code.code_hash <> p_code_hash then
    return false;
  end if;

  update login_codes set consumed_at = now() where id = v_code.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- The SMS ledger, before a tenant is known
-- ---------------------------------------------------------------------------
-- A student asking for a sign-in code has no tenant yet — the code is what will
-- eventually tell us which one. So the ledger row for it carries no
-- organization, and the tenant policy on `sms_messages` correctly refuses to
-- let the app role write it: in Postgres `NULL = app_current_org()` is NULL,
-- not true.
--
-- Rather than weaken that policy so a tenant could insert rows belonging to
-- nobody, these are narrow SECURITY DEFINER functions with a fixed shape, the
-- same seam `app_auth_issue_code` sits in two functions above. `src/db/unscoped.ts`
-- is the only module allowed to call them.
create or replace function app_sms_record(
  p_id uuid,
  p_organization_id uuid,
  p_phone text,
  p_template text,
  p_provider text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into sms_messages
    (id, organization_id, phone, template, status, provider, created_at)
  values
    (p_id, p_organization_id, p_phone, p_template::"SmsTemplate", 'QUEUED', p_provider, now());
end;
$$;

create or replace function app_sms_close(
  p_id uuid,
  p_status text,
  p_provider_message_id text,
  p_cost_micros int,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update sms_messages
     set status = p_status::"SmsStatus",
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         cost_micros = coalesce(p_cost_micros, cost_micros),
         error = coalesce(p_error, error)
   where id = p_id;
end;
$$;

-- How many were actually sent today, for the safety ceiling. A count and
-- nothing else: it returns no phone, no id and no row.
create or replace function app_sms_sent_today()
returns bigint
language sql
security definer
set search_path = public
as $$
  select count(*)
    from sms_messages
   where created_at >= date_trunc('day', now())
     and status in ('SENT', 'DELIVERED');
$$;

revoke all on function app_sms_record(uuid, uuid, text, text, text) from public;
revoke all on function app_sms_close(uuid, text, text, int, text) from public;
revoke all on function app_sms_sent_today() from public;
grant execute on function app_sms_record(uuid, uuid, text, text, text) to sahayak_app;
grant execute on function app_sms_close(uuid, text, text, int, text) to sahayak_app;
grant execute on function app_sms_sent_today() to sahayak_app;

-- The student's memberships, for the same pre-tenant reason as the teacher's.
revoke all on function app_auth_issue_code(text, bytea, timestamptz) from public;
revoke all on function app_auth_consume_code(text, bytea) from public;
grant execute on function app_auth_issue_code(text, bytea, timestamptz) to sahayak_app;
grant execute on function app_auth_consume_code(text, bytea) to sahayak_app;
revoke all on function app_auth_verify_code(text, bytea) from public;
grant execute on function app_auth_verify_code(text, bytea) to sahayak_app;

-- ---------------------------------------------------------------------------
-- Scheduled maintenance: finding tenants with work to do
-- ---------------------------------------------------------------------------

-- The expiry sweep has the mirror image of the sign-in problem. Sign-in cannot
-- scope a lookup because it does not yet know the tenant; the sweep cannot
-- scope one because it must visit EVERY tenant, and RLS shows it exactly one.
--
-- The answer is the same shape: a function so narrow it cannot be repurposed.
-- It returns organization ids and nothing else — no student, no attempt, no
-- answer — so the worst a bug in the caller can do with the result is open a
-- properly scoped withTenant() transaction, which is what it is for. The
-- actual submitting and marking still happens under RLS, one tenant at a time.
create or replace function app_maint_orgs_with_expired_attempts(p_now timestamptz)
  returns table (organization_id uuid)
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select distinct a.organization_id
  from attempts a
  where a.status = 'IN_PROGRESS'
    and a.expires_at < p_now
$$;

grant execute on function app_maint_orgs_with_expired_attempts(timestamptz) to sahayak_app;

-- Tenants holding a mastery estimate that has not been recomputed since a
-- cutoff. Same narrow shape as the expiry sweep's function, and for the same
-- reason: the job must visit every tenant, and RLS shows it exactly one.
--
-- Why this job exists at all: the estimate decays with time, and time passes
-- whether or not a student answers anything. Without a periodic recompute, a
-- student who stopped work in July keeps July's confident number into December
-- and the recency weighting never fires for exactly the people it matters most
-- for.
create or replace function app_maint_orgs_with_stale_mastery(p_before timestamptz)
  returns table (organization_id uuid)
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select distinct m.organization_id
  from student_concept_mastery m
  where m.computed_at < p_before
$$;

grant execute on function app_maint_orgs_with_stale_mastery(timestamptz) to sahayak_app;

-- Organizations holding mistakes nothing has classified yet.
--
-- The nightly typing pass is the largest AI line in the product by call count,
-- so it must not wake for tenants with nothing to do. Ids only, like every
-- other function here — the classifying itself happens tenant by tenant inside
-- withTenant(), under the same policies as a browser request.
create or replace function app_maint_orgs_with_unclassified_mistakes()
  returns table (organization_id uuid)
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select distinct m.organization_id
  from student_mistakes m
  where m.type_source = 'PENDING'
$$;

grant execute on function app_maint_orgs_with_unclassified_mistakes() to sahayak_app;

-- ---------------------------------------------------------------------------
-- The AI ledgers
-- ---------------------------------------------------------------------------

-- ai_generations and ai_usage carry a nullable organization_id, exactly like
-- audit_logs: NULL marks a platform-level operation with no tenant behind it.
--
-- The nullability is safe rather than convenient. In Postgres `NULL = x` is
-- NULL, not true, so a NULL row matches no tenant policy and is invisible to
-- every organization — which is the intended reading of "belongs to nobody",
-- and the opposite of the usual nullable-foreign-key hazard.
do $$
declare
  t text;
begin
  -- `sms_messages` joins them for the same reason: a student signing in has no
  -- tenant yet, so an OTP row belongs to nobody until the code is verified.
  foreach t in array array['ai_generations', 'ai_usage', 'sms_messages'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I
         using (organization_id = app_current_org())
         with check (organization_id = app_current_org())', t);
  end loop;
end $$;

-- prompt_versions is on the global plane with the curriculum, and for the same
-- reason: a prompt is platform property. One tenant editing the prompt every
-- other tenant's questions come from is not a feature. Readable by all,
-- writable by the platform role alone.
alter table prompt_versions enable row level security;
alter table prompt_versions force row level security;

drop policy if exists prompt_versions_read on prompt_versions;
create policy prompt_versions_read on prompt_versions
  for select using (true);

drop policy if exists prompt_versions_write on prompt_versions;
create policy prompt_versions_write on prompt_versions
  for all to sahayak_platform
  using (true) with check (true);

revoke insert, update, delete on prompt_versions from sahayak_app;
grant select on prompt_versions to sahayak_app;
grant select, insert, update, delete on prompt_versions to sahayak_platform;

-- ---------------------------------------------------------------------------
-- Plans and entitlements
-- ---------------------------------------------------------------------------

-- On the global plane with the curriculum and the prompts, and for the same
-- reason: a plan is platform property. A tenant able to edit the limits it is
-- billed against is not a feature, so the app role may read and never write.
do $$
declare
  t text;
begin
  foreach t in array array['plans', 'entitlements'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);

    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select using (true)', t, t);

    execute format('drop policy if exists %I_write on %I', t, t);
    execute format(
      'create policy %I_write on %I for all to sahayak_platform
         using (true) with check (true)', t, t);

    execute format('revoke insert, update, delete on %I from sahayak_app', t);
    execute format('grant select on %I to sahayak_app', t);
    execute format('grant select, insert, update, delete on %I to sahayak_platform', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- What the platform console may read
-- ---------------------------------------------------------------------------

-- The platform operator needs two cross-tenant views to run this thing at all:
-- what the AI is costing across every customer, and an audit trail that can be
-- searched when something has gone wrong.
--
-- Granted narrowly and deliberately:
--
--   * READ ONLY. The platform role may not write a tenant's ledger or edit an
--     audit row; `audit_logs` is append-only for everybody anyway, by trigger.
--   * To `sahayak_platform`, which is a SEPARATE connection from the one the
--     app holds. A teacher-facing route physically cannot use it, exactly as
--     with curriculum authoring.
--   * Nothing about students. These three tables carry organization ids,
--     token counts, costs and action names — not answers, not names, not
--     anything a student wrote.
--
-- The alternative was a superuser connection or BYPASSRLS, either of which
-- would have handed the console every table in the database to solve a
-- reporting problem.
do $$
declare
  t text;
begin
  -- `organizations` is on the list because a console that cannot name a tenant
  -- is a console of uuids. It carries a name, a slug and a type — no student
  -- work, no contact details for anybody.
  foreach t in array array['ai_usage', 'ai_generations', 'audit_logs', 'organizations'] loop
    execute format('drop policy if exists platform_read on %I', t);
    execute format(
      'create policy platform_read on %I for select to sahayak_platform
         using (true)', t);
    execute format('grant select on %I to sahayak_platform', t);
  end loop;
end $$;

-- sms_messages: a COLUMN grant, not a table grant.
--
-- The console needs what SMS costs and how much of it fails, and neither of
-- those questions needs a phone number. This is the first cross-tenant table
-- that carries a contact detail, so it is the first place the distinction
-- matters: the four tables above were chosen precisely because they hold no
-- student data, and adding a table with a phone in it would have quietly
-- retired that property.
--
-- Postgres grants privileges per column. `phone` and `error` are simply not in
-- the list, so the platform connection cannot select them at all — not by
-- convention, and not by a query somebody remembers to write carefully.
--
-- Reading a specific number back — "did 98765 43210 get their code" — is a
-- support action over DIRECT_URL, which is the same place granting a platform
-- admin lives, and for the same reason.
drop policy if exists platform_read on sms_messages;
create policy platform_read on sms_messages
  for select to sahayak_platform
  using (true);
grant select (id, organization_id, template, status, provider, cost_micros, created_at)
  on sms_messages to sahayak_platform;

-- ---------------------------------------------------------------------------
-- MIS/ERP webhooks: the outbox emitters
-- ---------------------------------------------------------------------------
--
-- DATABASE_SCHEMA.md section 9: an outbox row is "written in the same
-- transaction as the state change". These triggers are how that is guaranteed
-- rather than remembered.
--
-- Why a trigger and not a line of application code
-- ---------------------------------------------------------------------------
-- A call to `emit()` at the end of `publishAssessment` is correct on the day it
-- is written and stops being correct the first time somebody publishes a paper
-- from anywhere else — a backfill, an admin fix, a second code path added by
-- somebody who never read that function. The trigger fires for all of them,
-- and it fires INSIDE whatever transaction made the change, which is the one
-- property the whole outbox pattern exists for.
--
-- The cost is that the payload is assembled in SQL. It is kept to the columns
-- of the row being changed for exactly that reason: no joins, no lookups, and
-- nothing here that has to be maintained in step with a feature. Everything
-- richer than that is assembled at delivery time in core/webhooks/payload.ts,
-- where it can be typed and tested.
--
-- These are NOT security definer. They run as whoever made the change, so the
-- insert is checked against the tenant policy on `outbox` like any other write:
-- a trigger that bypassed RLS would be a hole in tenancy opened by a feature
-- that has nothing to do with tenancy.

-- Fails at `npm run db:rls` if a topic name below has been mistyped, which is
-- the whole reason WebhookEvent is an enum. A misspelled free-text topic is an
-- event that is written, published, matched against nobody's subscription and
-- dropped in silence.
do $$
begin
  perform 'ASSESSMENT_PUBLISHED'::"WebhookEvent";
  perform 'RESULTS_RELEASED'::"WebhookEvent";
  perform 'STUDENT_ENROLLED'::"WebhookEvent";
end $$;

-- ---------------------------------------------------------------------------
-- Never throw out of the emit path
-- ---------------------------------------------------------------------------
-- This is the one place in the feature where a bug could cost a teacher their
-- work. A trigger that raises aborts the statement that fired it, so a broken
-- outbox insert would fail the publish, the release or the roster import — the
-- exact inversion of the promise: a webhook must never be able to break the
-- thing it is reporting on.
--
-- So every emitter body sits inside a subtransaction with an exception handler.
-- A failure here rolls back the outbox insert alone, writes a warning to the
-- server log, and leaves the state change untouched. The event is then lost,
-- which is the correct trade: an event that never arrives is a support call,
-- and a publish that fails is a lesson.
--
-- Same rule, and the same reasoning, as `sendSms()` never throwing on the
-- sign-in path.

create or replace function app_outbox_assessment_published()
  returns trigger
  language plpgsql
as $$
begin
  if new.status = 'PUBLISHED' and old.status is distinct from 'PUBLISHED' then
    begin
      insert into outbox (id, organization_id, topic, payload, created_at)
      values (
        gen_random_uuid(),
        new.organization_id,
        'ASSESSMENT_PUBLISHED'::"WebhookEvent",
        jsonb_build_object(
          'assessmentId',    new.id,
          'title',           new.title,
          'subjectId',       new.subject_id,
          'gradeId',         new.grade_id,
          'classId',         new.class_id,
          'totalMarks',      new.total_marks,
          'durationMinutes', new.duration_minutes,
          'publishedAt',     to_char(new.published_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        now()
      );
    exception when others then
      raise warning 'outbox: could not queue ASSESSMENT_PUBLISHED for assessment % (%)', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists assessments_outbox_published on assessments;
create trigger assessments_outbox_published
  after update on assessments
  for each row execute function app_outbox_assessment_published();

-- Results, at RELEASE and never at submission.
--
-- `results_released_at` going from null to a value is the only transition that
-- counts, and it is what the product itself treats as the moment a mark stops
-- being provisional. Firing on submission instead would route an integration
-- around `resultsVisible()` and put half-marked papers into a school's report
-- system before the child who sat one has seen anything.
create or replace function app_outbox_results_released()
  returns trigger
  language plpgsql
as $$
begin
  if new.results_released_at is not null and old.results_released_at is null then
    begin
      insert into outbox (id, organization_id, topic, payload, created_at)
      values (
        gen_random_uuid(),
        new.organization_id,
        'RESULTS_RELEASED'::"WebhookEvent",
        jsonb_build_object(
          'assignmentId', new.id,
          'assessmentId', new.assessment_id,
          'classId',      new.class_id,
          'releasedAt',   to_char(new.results_released_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        now()
      );
    exception when others then
      raise warning 'outbox: could not queue RESULTS_RELEASED for assignment % (%)', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists assignments_outbox_released on assignments;
create trigger assignments_outbox_released
  after update on assignments
  for each row execute function app_outbox_results_released();

-- A student is on a roster.
--
-- INSERT only, and only for an ACTIVE row. A student who leaves is a different
-- event that nothing subscribes to yet, and inventing one now would mean
-- inventing what an MIS should do with it.
create or replace function app_outbox_student_enrolled()
  returns trigger
  language plpgsql
as $$
begin
  if new.status = 'ACTIVE' then
    begin
      insert into outbox (id, organization_id, topic, payload, created_at)
      values (
        gen_random_uuid(),
        new.organization_id,
        'STUDENT_ENROLLED'::"WebhookEvent",
        jsonb_build_object(
          'enrolmentId',   new.id,
          'classId',       new.class_id,
          -- Our uuid for the student, and deliberately nothing else. An MIS
          -- knows its own children by name; it does not need one from us, and
          -- a phone number sent to a school server is a phone number in a
          -- system whose retention nobody here can describe.
          'studentUserId', new.student_user_id,
          'joinedAt',      to_char(new.joined_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        now()
      );
    exception when others then
      raise warning 'outbox: could not queue STUDENT_ENROLLED for enrolment % (%)', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists class_enrolments_outbox_enrolled on class_enrolments;
create trigger class_enrolments_outbox_enrolled
  after insert on class_enrolments
  for each row execute function app_outbox_student_enrolled();

-- ---------------------------------------------------------------------------
-- Which tenants have webhook work
-- ---------------------------------------------------------------------------
--
-- The delivery runner has the sweep's problem, not sign-in's: it must visit
-- EVERY tenant, and RLS shows it exactly one. Answered the same way as the
-- expiry sweep and the mastery refresh — a function so narrow it cannot be
-- repurposed, returning organization ids and nothing else. No outbox row, no
-- job, no payload. The worst a bug in the caller can do with the result is open
-- a correctly scoped withTenant() transaction, which is what it is for.
--
-- Three kinds of work, and the third is the one that is easy to forget: a
-- runner that died mid-delivery left a RUNNING row whose lock has since
-- expired, and without this it would sit there forever looking busy.
create or replace function app_maint_orgs_with_webhook_work(p_now timestamptz)
  returns table (organization_id uuid)
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select o.organization_id from outbox o where o.published_at is null
  union
  select j.organization_id from jobs j
   where (j.status = 'PENDING' and j.run_after <= p_now)
      or (j.status = 'RUNNING' and j.locked_until < p_now)
$$;

revoke all on function app_maint_orgs_with_webhook_work(timestamptz) from public;
grant execute on function app_maint_orgs_with_webhook_work(timestamptz) to sahayak_app;

-- ---------------------------------------------------------------------------
-- The shared question library
-- ---------------------------------------------------------------------------
-- The library sweep has the scheduled jobs' problem: it must find the tenants
-- still waiting for the library before it can copy anything, and RLS shows it
-- exactly one. Ids only, as everywhere in this section. The source organization
-- is resolved by slug through the same narrow shape: one exact identifier in,
-- one id out.
--
-- A school is waiting when it asked (library_requested_at, stamped by the
-- column default at creation) and either was never synced, or was synced
-- without the Exemplar questions that are now switched on. CBSE only: the
-- library is CBSE's syllabus, and copying it into an ICSE school would file
-- every question under a board that school does not teach.
create or replace function app_maint_library_source(p_slug text)
  returns uuid
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select o.id from organizations o where o.slug = p_slug and o.deleted_at is null
$$;

grant execute on function app_maint_library_source(text) to sahayak_app;

create or replace function app_maint_orgs_needing_library(
  p_source uuid,
  p_include_exemplar boolean,
  p_limit integer
)
  returns table (organization_id uuid)
  language sql
  security definer
  set search_path = public, pg_temp
  stable
as $$
  select o.id
  from organizations o
  join boards b on b.id = o.board_id
  where o.deleted_at is null
    and o.id <> p_source
    and b.code = 'CBSE'
    and o.library_requested_at is not null
    and (o.library_synced_at is null
         or (p_include_exemplar and not o.library_includes_exemplar))
  order by o.library_requested_at
  limit greatest(p_limit, 0)
$$;

grant execute on function app_maint_orgs_needing_library(uuid, boolean, integer) to sahayak_app;

-- ---------------------------------------------------------------------------
-- Supabase hardening
-- ---------------------------------------------------------------------------
-- Supabase creates `anon` and `authenticated` for its public Data API and, by
-- default, grants them every table in `public` — and Postgres grants EXECUTE on
-- every function to PUBLIC. This app never uses that API: it connects as
-- sahayak_app and sahayak_platform. Left alone, the curriculum policies
-- (`for select using (true)`) would make the syllabus readable to anyone with
-- the project's public anon key, and the pre-tenant SECURITY DEFINER functions
-- would be callable as RPCs without a session.
--
-- So on Supabase, and only there (the roles do not exist locally), both roles
-- lose everything, PUBLIC loses EXECUTE, and the two app roles are granted
-- EXECUTE explicitly so policies and triggers keep working.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from anon, authenticated;
    revoke execute on all functions in schema public from public;
    grant execute on all functions in schema public to sahayak_app, sahayak_platform;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
    alter default privileges in schema public revoke execute on functions from public;
  end if;
end $$;
