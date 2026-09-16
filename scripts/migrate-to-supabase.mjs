/**
 * Move the real data from the local database into Supabase, once.
 *
 *     node scripts/migrate-to-supabase.mjs              # dry run: what would be copied
 *     node scripts/migrate-to-supabase.mjs --commit     # do it
 *     node scripts/migrate-to-supabase.mjs --commit --orgs sirah-digital,another-school
 *     node scripts/migrate-to-supabase.mjs --commit --rehearsal   # into a spare LOCAL database
 *
 * `--rehearsal` allows a local DIRECT_URL, so the whole move — migrations, copy,
 * policies, verification — can be run end to end against an empty scratch
 * database before it is ever run against Supabase.
 *
 * Reads:
 *   SOURCE_DIRECT_URL  the LOCAL superuser connection (the old DIRECT_URL)
 *   DIRECT_URL         the SUPABASE postgres connection (session pooler, port 5432)
 *   APP_DB_PASSWORD, PLATFORM_DB_PASSWORD  strong passwords for the two app roles
 *
 * ---------------------------------------------------------------------------
 * What "real data only" means
 * ---------------------------------------------------------------------------
 * The local database holds ~17,000 organisations and ~45,000 users, and all but
 * one organisation were created by test runs. So nothing is copied by default
 * except:
 *
 *   - the shared plane — boards, grades, subjects, chapters, topics, outcomes,
 *     concepts, plans, entitlements, prompt versions — WITHOUT test fixtures
 *     (chapters numbered 1000+, subjects coded ZZ…), and only concepts that
 *     measure a copied outcome;
 *   - the organisations named in --orgs (default: sirah-digital), every tenant
 *     row that belongs to them, and the users who are members of them or
 *     linked to their students as parents;
 *   - minus the ~36,000 soft-deleted TEST questions a bulk SQL statement moved
 *     into Sirah Digital on 11 September 2026 (CLAUDE.md, "The NCERT import").
 *
 * Never copied: sessions (everybody signs in again), sign-in codes, the SMS
 * ledger. A row whose foreign-key parent was not copied is left out and
 * COUNTED, so nothing disappears without the report saying so.
 *
 * ---------------------------------------------------------------------------
 * Order, and why
 * ---------------------------------------------------------------------------
 *   1. prisma migrate deploy against Supabase — the tables, exactly as locally.
 *   2. Refuse unless Supabase has no organisations yet: this is a one-time move,
 *      and running it twice must not double anything.
 *   3. Copy table by table in foreign-key order, keeping every id. Row-level
 *      security is not applied yet, so the copy is not filtered by policies
 *      that need a tenant context; the audit and outbox triggers do not exist
 *      yet, so copying history does not invent new history.
 *   4. npm run db:rls against Supabase — policies, roles, triggers, and the
 *      Supabase hardening block (revoking the anon/authenticated API roles).
 *   5. Count every table on both sides and fail loudly on any difference.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import pg from "pg";

// Timestamps travel as the exact text Postgres stored. The driver otherwise
// reads a zone-less timestamp as LOCAL time and serialises it back as UTC,
// which on a machine in India would shift every date in the copy by 5h30.
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (value) => value);

const commit = process.argv.includes("--commit");
const rehearsal = process.argv.includes("--rehearsal");
const orgsArg = process.argv[process.argv.indexOf("--orgs") + 1];
const ORG_SLUGS = process.argv.includes("--orgs") && orgsArg ? orgsArg.split(",") : ["sirah-digital"];

const SOURCE = process.env.SOURCE_DIRECT_URL;
const TARGET = process.env.DIRECT_URL;
const BATCH = 500;

/** Never copied, whatever organisation they belong to. */
const SKIP = new Set(["_prisma_migrations", "sessions", "login_codes", "sms_messages"]);

function host(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!SOURCE) fail("SOURCE_DIRECT_URL is not set. Put the LOCAL superuser connection there (the old DIRECT_URL).");
if (!TARGET) fail("DIRECT_URL is not set. Put the Supabase postgres connection there.");
const targetIsLocal = ["localhost", "127.0.0.1", "::1"].includes(host(TARGET));
if (targetIsLocal && !rehearsal) {
  fail(`DIRECT_URL points at ${host(TARGET)}. It must be the Supabase connection; SOURCE_DIRECT_URL is the local one.`);
}
if (
  host(SOURCE) === host(TARGET) &&
  new URL(SOURCE).port === new URL(TARGET).port &&
  new URL(SOURCE).pathname === new URL(TARGET).pathname
) {
  fail("SOURCE_DIRECT_URL and DIRECT_URL point at the same database.");
}

const source = new pg.Client({ connectionString: SOURCE });
// Supabase requires TLS; a local rehearsal database does not offer it.
/**
 * A pg client for a Supabase URL. `sslmode` is taken OUT of the URL and TLS is
 * configured here instead: with `sslmode=require` in the string, pg verifies
 * the certificate chain against a CA it does not ship, and Supabase's pooler
 * fails with "self-signed certificate in certificate chain". The connection is
 * still encrypted; Prisma, which reads the same URL, handles sslmode itself.
 */
function clientFor(url, local) {
  if (local) return new pg.Client({ connectionString: url });
  const parsed = new URL(url);
  parsed.searchParams.delete("sslmode");
  return new pg.Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } });
}

const target = clientFor(TARGET, targetIsLocal);

/** Tables in foreign-key order: every parent before its children. */
async function orderedTables() {
  const tables = (
    await source.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    )
  ).rows.map((row) => row.table_name);
  const fks = (
    await source.query(
      `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
              a.attname as column_name, pa.attname as parent_column
         from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
         join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
        where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1`,
    )
  ).rows;
  const clean = (name) => name.replace(/^public\./, "").replace(/"/g, "");
  const parents = new Map(tables.map((t) => [t, []]));
  for (const fk of fks) parents.get(clean(fk.child))?.push({ ...fk, child: clean(fk.child), parent: clean(fk.parent) });

  const ordered = [];
  const done = new Set();
  const visit = (table, stack = new Set()) => {
    if (done.has(table)) return;
    if (stack.has(table)) throw new Error(`Foreign-key cycle through ${table}`);
    stack.add(table);
    for (const fk of parents.get(table) ?? []) if (fk.parent !== table) visit(fk.parent, stack);
    stack.delete(table);
    done.add(table);
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return { ordered, parents };
}

async function columnsOf(client, table) {
  return (
    await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1 order by ordinal_position`,
      [table],
    )
  ).rows.map((row) => row.column_name);
}

/** json/jsonb columns, which need their JSON `null` values carried explicitly. */
async function jsonColumnsOf(client, table) {
  return (
    await client.query(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = $1 and data_type in ('json', 'jsonb')`,
      [table],
    )
  ).rows;
}

/**
 * A JSON `null` stored in a json/jsonb column is a value, not an absent one —
 * the audit log writes it for "no before" — and json_populate_recordset turns
 * it into SQL NULL. So it travels as a sentinel string and is restored after
 * the insert. Found by fingerprinting the rehearsal copy, not by the row count,
 * which matched.
 */
const JSON_NULL_SENTINEL = "__sahayak_json_null__";

/** The WHERE clause that decides which rows of a table are real. */
function scopeFor(table, columns, orgIds, userIds) {
  const clauses = [];
  const params = [];
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  switch (table) {
    case "subjects":
      clauses.push(`code not like 'ZZ%'`);
      break;
    case "chapters":
      clauses.push(`number < 1000`);
      break;
    case "concepts":
      clauses.push(`exists (select 1 from concept_outcomes co
                     join learning_outcomes lo on lo.id = co.learning_outcome_id
                     join topics t on t.id = lo.topic_id
                     join chapters c on c.id = t.chapter_id
                    where co.concept_id = concepts.id and c.number < 1000)`);
      break;
    case "organizations":
      clauses.push(`id = any(${param(orgIds)}::uuid[])`);
      break;
    case "users":
      clauses.push(`id = any(${param(userIds)}::uuid[])`);
      break;
    case "questions":
      // The bulk-moved test questions: soft-deleted and not part of the bank.
      clauses.push(`not (deleted_at is not null and source <> 'IMPORTED')`);
      break;
  }
  if (columns.includes("organization_id") && table !== "organizations") {
    clauses.push(`organization_id = any(${param(orgIds)}::uuid[])`);
  }
  return { clauses, params, param };
}

async function main() {
  await source.connect();
  await target.connect();

  const orgRows = (
    await source.query(`select id, name, slug from organizations where slug = any($1::text[]) and deleted_at is null`, [ORG_SLUGS])
  ).rows;
  const missing = ORG_SLUGS.filter((slug) => !orgRows.some((row) => row.slug === slug));
  if (missing.length) fail(`No organisation with slug: ${missing.join(", ")}`);
  const orgIds = orgRows.map((row) => row.id);

  const userIds = (
    await source.query(
      `select distinct user_id as id from memberships where organization_id = any($1::uuid[])
       union
       select distinct parent_user_id from parent_student_links where organization_id = any($1::uuid[])`,
      [orgIds],
    )
  ).rows.map((row) => row.id);

  console.log(`\nSupabase migration — ${commit ? "COMMIT" : "dry run"}`);
  console.log(`  organisations: ${orgRows.map((row) => row.name).join(", ")}`);
  console.log(`  users:         ${userIds.length}`);

  if (commit) {
    console.log("\n1. Applying migrations to Supabase…");
    const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, DATABASE_URL: TARGET, DIRECT_URL: TARGET },
    });
    if (migrate.status !== 0) fail("prisma migrate deploy failed against Supabase. Nothing was copied.");

    const existing = await target.query(`select count(*)::int as n from organizations`);
    if (existing.rows[0].n > 0) {
      fail(`Supabase already has ${existing.rows[0].n} organisation(s). This is a one-time move and refuses to run twice.`);
    }
  }

  const { ordered, parents } = await orderedTables();

  if (commit) {
    // Some migrations seed rows of their own — the board migration inserts a
    // CBSE row if none exists — and those rows carry ids the local database has
    // never seen. Every subject and organisation points at the LOCAL ids, so the
    // target is emptied (safe: step 2 proved no organisation exists yet) and
    // every row comes from the source, id for id.
    const toClear = ordered.filter((table) => !SKIP.has(table) || table !== "_prisma_migrations");
    const clearable = toClear.filter((table) => table !== "_prisma_migrations");
    await target.query(`truncate ${clearable.map((table) => `"${table}"`).join(", ")} cascade`);
    console.log(`
3. Emptied ${clearable.length} tables the migrations may have seeded. Copying…`);
  }
  const copiedIds = new Map();
  const report = [];

  for (const table of ordered) {
    if (SKIP.has(table)) continue;
    const columns = await columnsOf(source, table);
    const { clauses, params, param } = scopeFor(table, columns, orgIds, userIds);
    const scopedClauses = clauses.length;
    const scopedParams = params.length;

    // A row is copied only if every foreign-key parent it names was copied.
    for (const fk of parents.get(table) ?? []) {
      const ids = copiedIds.get(fk.parent);
      if (!ids) continue; // parent not scoped by id (or skipped): nothing to check against
      clauses.push(`("${fk.column_name}" is null or "${fk.column_name}" = any(${param([...ids])}::uuid[]))`);
    }
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";

    const scopedWhere = scopedClauses ? `where ${clauses.slice(0, scopedClauses).join(" and ")}` : "";
    const eligible = (await source.query(`select count(*)::int as n from "${table}" ${scopedWhere}`, params.slice(0, scopedParams))).rows[0].n;
    const total = (await source.query(`select count(*)::int as n from "${table}" ${where}`, params)).rows[0].n;
    // In scope, but naming a parent that was not copied — reported, never silent.
    const skippedForParents = eligible - total;
    report.push({ table, rows: total, skippedForParents });

    const hasId = columns.includes("id");
    const ids = hasId ? new Set() : null;
    if (commit && total > 0) {
      const cursorName = `c_${table}`;
      await source.query("begin");
      const jsonColumns = await jsonColumnsOf(source, table);
      const selectList = columns
        .map((column) => {
          const json = jsonColumns.find((entry) => entry.column_name === column);
          if (!json) return `"${column}"`;
          return `case when "${column}"::text = 'null' then to_jsonb('${JSON_NULL_SENTINEL}'::text)::${json.data_type} else "${column}" end as "${column}"`;
        })
        .join(", ");
      await source.query(`declare ${cursorName} cursor for select ${selectList} from "${table}" ${where}`, params);
      await target.query("begin");
      try {
        for (;;) {
          const batch = await source.query(`fetch ${BATCH} from ${cursorName}`);
          if (batch.rows.length === 0) break;
          if (ids) for (const row of batch.rows) ids.add(row.id);
          await target.query(
            `insert into "${table}" select * from json_populate_recordset(null::"${table}", $1::json)`,
            [JSON.stringify(batch.rows, (_key, value) => (value && value.type === "Buffer" ? `\\x${Buffer.from(value.data).toString("hex")}` : value))],
          );
        }
        for (const json of jsonColumns) {
          await target.query(
            `update "${table}" set "${json.column_name}" = 'null'::${json.data_type}
              where "${json.column_name}"::text = $1`,
            [JSON.stringify(JSON_NULL_SENTINEL)],
          );
        }
        await target.query("commit");
      } catch (error) {
        await target.query("rollback");
        throw new Error(`Copying ${table} failed: ${error.message}`);
      } finally {
        await source.query(`close ${cursorName}`);
        await source.query("commit");
      }
    } else if (ids) {
      const rows = (await source.query(`select id from "${table}" ${where}`, params)).rows;
      for (const row of rows) ids.add(row.id);
    }
    if (ids) copiedIds.set(table, ids);
    process.stdout.write(`  ${table.padEnd(26)} ${String(total).padStart(7)}${skippedForParents ? `   (${skippedForParents} left out: parent not copied)` : ""}\n`);
  }

  if (!commit) {
    console.log("\nNothing written. Re-run with --commit to apply.");
    return;
  }

  console.log("\n4. Applying row-level security, roles and triggers to Supabase…");
  if (!process.env.APP_DB_PASSWORD || !process.env.PLATFORM_DB_PASSWORD) {
    fail("APP_DB_PASSWORD and PLATFORM_DB_PASSWORD must be set to strong passwords before db:rls runs on Supabase.");
  }
  const rls = spawnSync("npm", ["run", "db:rls"], { stdio: "inherit", shell: true, env: process.env });
  if (rls.status !== 0) fail("db:rls failed against Supabase. The data is copied; fix the error and run `npm run db:rls` again.");

  console.log("\n5. Verifying every table…");
  let mismatches = 0;
  for (const { table, rows } of report) {
    const n = (await target.query(`select count(*)::int as n from "${table}"`)).rows[0].n;
    if (n !== rows) {
      mismatches++;
      console.log(`  MISMATCH ${table}: expected ${rows}, Supabase has ${n}`);
    }
  }
  if (mismatches) fail(`${mismatches} table(s) do not match. Do not switch the app over until this is resolved.`);
  console.log(`  All ${report.length} tables match.\n\nDone. Now point DATABASE_URL and PLATFORM_DATABASE_URL at Supabase and run npm run audit:rls.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  });
