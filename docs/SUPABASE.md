# Moving the database to Supabase

After this, **Supabase is the only database**. The app, the platform console and
every scheduled job read and write it directly, so there is no second copy to keep
in step and nothing that can be missed. The local Docker database stays, but only
for running the test suites — which refuse to run against Supabase.

The move copies **real data only**: the curriculum (chapters, outcomes, concepts,
reviews), plans, and the Sirah Digital organisation with its question bank, classes,
students, papers, results and audit log. The ~17,000 test organisations the test
suites created are left behind. Signed-in sessions are not copied: everybody signs
in once more.

It has been rehearsed end to end against a scratch database: migrations, copy,
row-level security, then a row-by-row comparison — 13,462 rows across 57 tables,
every one identical to the source.

---

## 1. In the Supabase dashboard

1. **Region.** If the project is not yet in *Mumbai (ap-south-1)*, consider creating
   it there: students' data then stays in India, and the app is faster.
2. **Turn off the Data API.** *Project Settings → Data API* → remove `public` from
   the exposed schemas (or disable the Data API). The app never uses it. The
   migration also revokes the API roles' access, but closing the door twice costs
   nothing.
3. **Get the connection strings.** *Connect* (top bar) → *Session pooler* (port
   **5432**). It looks like:

   ```
   postgresql://postgres.<project-ref>:<your-db-password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```

   Use the **session** pooler, not the transaction pooler (6543), and not the
   direct `db.<ref>.supabase.co` host — that one is IPv6-only unless you buy the
   IPv4 add-on, and many Indian home and office networks cannot reach it.
4. **Backups.** On the Free plan Supabase keeps **no backups** and pauses a project
   after a week without traffic. For real school data, use **Pro** (daily backups
   kept for 7 days) and add **Point-in-Time Recovery**, which is what actually means
   "nothing is lost": any moment in the retention window can be restored.

## 2. Edit `.env` (never paste passwords into chat)

Keep the old local connection as the SOURCE, and point everything else at Supabase:

```bash
# The local database the data is copied FROM (your current DIRECT_URL):
SOURCE_DIRECT_URL="postgresql://postgres:postgres@localhost:5434/sahayak?schema=public"

# Supabase — session pooler, port 5432. Replace <ref> and <db-password>.
DIRECT_URL="postgresql://postgres.<ref>:<db-password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require&connection_limit=2&pool_timeout=20"

# Two strong, DIFFERENT passwords (e.g. `openssl rand -base64 24`). The migration
# creates the app's two database roles with them. Avoid @ : / ? # in them.
APP_DB_PASSWORD="<strong password 1>"
PLATFORM_DB_PASSWORD="<strong password 2>"

# The pooler allows 15 client connections on the Free plan, and Prisma opens
# about two per CPU core PER CLIENT unless told otherwise — which exhausted it
# ("EMAXCONNSESSION max clients reached") with one teacher browsing. Every URL
# therefore carries connection_limit: app 8 + platform 3 + migrations 2 = 13.
# A deployment running several app instances must divide that budget between them.
#
# The app's own connections. Note the ".<ref>" after the role name — that is how
# the Supabase pooler knows which project a role belongs to.
DATABASE_URL="postgresql://sahayak_app.<ref>:<strong password 1>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require&connection_limit=8&pool_timeout=20"
PLATFORM_DATABASE_URL="postgresql://sahayak_platform.<ref>:<strong password 2>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require&connection_limit=3&pool_timeout=20"
```

## 3. Stop the app, then run the move

Stop `npm run dev` first, so nothing is written locally while the copy runs.

```bash
node scripts/migrate-to-supabase.mjs              # dry run: shows what will be copied
node scripts/migrate-to-supabase.mjs --commit     # the move
node scripts/verify-supabase-copy.mjs             # row-by-row proof it is identical
npm run audit:rls                                 # policies are on every table
```

The move refuses to run if Supabase already has an organisation, so it cannot copy
twice. It prints every table with its row count, and anything left out because it
belonged to test data. If the verification reports any difference, do not continue —
send me its output.

## 4. Start the app on Supabase

```bash
npm run dev
```

Sign in as the owner and as a student (for example 9282078664, Kavya Selvam) and
check the question bank, Class 9-A and the dashboard.

## Running the tests afterwards

Every test suite now checks where it is pointed and **refuses a remote database**.
To run tests, point `.env` back at the local Docker database (`npm run db:up`), or
keep a second copy of the file for testing. `SAHAYAK_ALLOW_REMOTE_TESTS=1` exists
only for a separate, disposable Supabase *test* project — never set it for the real
one.
