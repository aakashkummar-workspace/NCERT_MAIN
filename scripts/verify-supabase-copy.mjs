/**
 * Proves the copy is exact: every row in the target, byte for byte, matches the
 * same row in the source.
 *
 *     node scripts/verify-supabase-copy.mjs
 *     node scripts/verify-supabase-copy.mjs --rehearsal     # target may be local
 *
 * Reads SOURCE_DIRECT_URL (local) and DIRECT_URL (Supabase, or a rehearsal DB).
 *
 * Row counts alone passed a copy that had turned JSON `null` values into SQL
 * NULL in the audit log. So this compares CONTENT: for every table, each target
 * row is looked up in the source by its primary key and the two rows are
 * compared as JSON. It reports rows that differ and rows missing from either
 * side of the copied set, and exits non-zero on any.
 */
import "dotenv/config";
import pg from "pg";

for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (value) => value);

const SOURCE = process.env.SOURCE_DIRECT_URL;
const TARGET = process.env.DIRECT_URL;
const rehearsal = process.argv.includes("--rehearsal");

if (!SOURCE || !TARGET) {
  console.error("Set SOURCE_DIRECT_URL (local) and DIRECT_URL (target).");
  process.exit(1);
}
const targetIsLocal = ["localhost", "127.0.0.1", "::1"].includes(new URL(TARGET).hostname);
if (targetIsLocal && !rehearsal) {
  console.error("DIRECT_URL is local. Pass --rehearsal to verify a local rehearsal copy.");
  process.exit(1);
}

const source = new pg.Client({ connectionString: SOURCE });
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

const BATCH = 1000;

async function primaryKey(client, table) {
  const rows = (
    await client.query(
      `select a.attname from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary
        order by array_position(i.indkey, a.attnum)`,
      [`public."${table}"`],
    )
  ).rows;
  return rows.map((row) => row.attname);
}

async function main() {
  await source.connect();
  await target.connect();

  const tables = (
    await target.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> '_prisma_migrations'
        order by 1`,
    )
  ).rows.map((row) => row.table_name);

  let problems = 0;
  let compared = 0;
  for (const table of tables) {
    const key = await primaryKey(target, table);
    if (key.length === 0) {
      console.log(`  SKIP ${table}: no primary key`);
      continue;
    }
    const keyExpr = key.map((column) => `"${column}"::text`).join(` || '|' || `);
    const targetRows = (await target.query(`select ${keyExpr} as k, to_jsonb(t)::text as j from "${table}" t`)).rows;
    let differing = 0;
    let missing = 0;
    for (let start = 0; start < targetRows.length; start += BATCH) {
      const batch = targetRows.slice(start, start + BATCH);
      const sourceRows = (
        await source.query(
          `select ${keyExpr} as k, to_jsonb(t)::text as j from "${table}" t where ${keyExpr} = any($1::text[])`,
          [batch.map((row) => row.k)],
        )
      ).rows;
      const bySource = new Map(sourceRows.map((row) => [row.k, row.j]));
      for (const row of batch) {
        const original = bySource.get(row.k);
        if (original === undefined) missing++;
        // jsonb normalises key order, so equal rows serialise identically.
        else if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(JSON.parse(row.j))) differing++;
      }
    }
    compared += targetRows.length;
    if (differing || missing) {
      problems += differing + missing;
      console.log(`  DIFF ${table}: ${differing} row(s) differ, ${missing} not found in the source`);
    }
  }

  console.log(`\nCompared ${compared} rows across ${tables.length} tables.`);
  if (problems) {
    console.log(`${problems} problem(s). Do not switch the app over.`);
    process.exitCode = 1;
  } else {
    console.log("Every copied row is identical to the source.");
  }
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
