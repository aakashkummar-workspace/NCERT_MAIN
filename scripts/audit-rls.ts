import "dotenv/config";
/**
 * The RLS audit.
 *
 * Reads the live catalog — never a migration file, never a hand-maintained list
 * — and fails if any table could leak across tenants. This runs last and
 * loudest in CI, because a tenancy guarantee that depends on everyone
 * remembering is not a guarantee.
 *
 * Checks:
 *   1. The application role is not superuser and does not have BYPASSRLS.
 *      Without this the other four checks pass while proving nothing.
 *   2. Every application table has row security ENABLED.
 *   3. Every application table has row security FORCED.
 *   4. Every application table has at least one policy.
 *   5. Every table with an organization_id column has a policy that actually
 *      references app_current_org() — a policy of `using (true)` satisfies
 *      check 4 and protects nothing.
 *
 * A table added later without a policy fails here on the day it is added.
 */
import { Client } from "pg";
import { pgConfig } from "./lib/pg-connection";

/**
 * Tables that legitimately have no tenant policy. Each needs a reason, and the
 * reason is reviewed when the list changes.
 */
const EXEMPT = new Map<string, string>([
  ["_prisma_migrations", "Prisma's own bookkeeping; contains no tenant data"],
]);

const APP_ROLE = "sahayak_app";

/**
 * The curriculum-authoring role. It legitimately writes the shared curriculum
 * plane, so the thing to check is that it did not also acquire the power to
 * ignore tenant isolation on its way there.
 */
const PLATFORM_ROLE = "sahayak_platform";

type Row = Record<string, unknown>;

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) {
    console.error("DIRECT_URL is not set.");
    process.exit(1);
  }

  const client = new Client(pgConfig(url));
  await client.connect();
  const failures: string[] = [];
  const notes: string[] = [];

  try {
    // ---- 1. The role must not be able to bypass what we are about to check --
    const role = await client.query<Row>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = $1`,
      [APP_ROLE],
    );

    if (role.rowCount === 0) {
      failures.push(
        `Role ${APP_ROLE} does not exist. Run: npm run db:rls`,
      );
    } else {
      const r = role.rows[0]!;
      if (r.rolsuper === true) {
        failures.push(
          `Role ${APP_ROLE} is a SUPERUSER. Superusers bypass row-level ` +
            `security unconditionally, so every policy below is inert and this ` +
            `audit proves nothing.`,
        );
      }
      if (r.rolbypassrls === true) {
        failures.push(
          `Role ${APP_ROLE} has BYPASSRLS. Same problem: every policy is inert.`,
        );
      }
      if (r.rolsuper === false && r.rolbypassrls === false) {
        notes.push(`Role ${APP_ROLE}: not superuser, no BYPASSRLS.`);
      }
    }

    // ---- 1b. The platform role must not bypass tenancy either --------------
    const platform = await client.query<Row>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = $1`,
      [PLATFORM_ROLE],
    );

    if (platform.rowCount === 0) {
      failures.push(
        `Role ${PLATFORM_ROLE} does not exist. Run: npm run db:rls`,
      );
    } else {
      const r = platform.rows[0]!;
      if (r.rolsuper === true || r.rolbypassrls === true) {
        failures.push(
          `Role ${PLATFORM_ROLE} can bypass row-level security. It writes the ` +
            `shared curriculum, which is fine; it must not also be able to read ` +
            `across tenants, which this would allow.`,
        );
      } else {
        notes.push(`Role ${PLATFORM_ROLE}: not superuser, no BYPASSRLS.`);
      }
    }

    // ---- 2, 3, 4. Enabled, forced, and has a policy ------------------------
    const tables = await client.query<Row>(`
      select c.relname                as table_name,
             c.relrowsecurity         as rls_enabled,
             c.relforcerowsecurity    as rls_forced,
             count(p.polname)::int    as policy_count,
             bool_or(
               pg_get_expr(p.polqual, p.polrelid) ilike '%app_current_org%'
               or pg_get_expr(p.polwithcheck, p.polrelid) ilike '%app_current_org%'
             )                        as references_tenant,
             exists (
               select 1 from information_schema.columns col
               where col.table_schema = 'public'
                 and col.table_name = c.relname
                 and col.column_name = 'organization_id'
             )                        as has_org_column
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public'
        and c.relkind = 'r'
      group by c.relname, c.relrowsecurity, c.relforcerowsecurity, c.oid
      order by c.relname
    `);

    if (tables.rowCount === 0) {
      failures.push("No tables found. Has the migration been applied?");
    }

    for (const row of tables.rows) {
      const name = String(row.table_name);
      if (EXEMPT.has(name)) {
        notes.push(`${name}: exempt — ${EXEMPT.get(name)}`);
        continue;
      }

      const enabled = row.rls_enabled === true;
      const forced = row.rls_forced === true;
      const policies = Number(row.policy_count ?? 0);
      const hasOrg = row.has_org_column === true;
      const refsTenant = row.references_tenant === true;

      if (!enabled) {
        failures.push(
          `${name}: row-level security is NOT enabled. ` +
            `Add it to prisma/rls.sql and run npm run db:rls.`,
        );
      }
      if (!forced) {
        failures.push(
          `${name}: row-level security is not FORCED. Without FORCE the table ` +
            `owner bypasses every policy on it.`,
        );
      }
      if (policies === 0) {
        failures.push(`${name}: RLS is on but no policy exists — this denies everything, which is a bug, not safety.`);
      }
      if (hasOrg && policies > 0 && !refsTenant) {
        failures.push(
          `${name}: has organization_id but no policy references ` +
            `app_current_org(). A policy that does not read the tenant context ` +
            `is not tenant isolation.`,
        );
      }

      if (enabled && forced && policies > 0 && (!hasOrg || refsTenant)) {
        notes.push(
          `${name}: enabled, forced, ${policies} ${policies === 1 ? "policy" : "policies"}` +
            (hasOrg ? ", tenant-scoped" : ""),
        );
      }
    }
  } finally {
    await client.end();
  }

  for (const note of notes) console.log(`  ok    ${note}`);

  if (failures.length > 0) {
    console.error(`\nRLS AUDIT FAILED — ${failures.length} problem(s):\n`);
    for (const f of failures) console.error(`  FAIL  ${f}`);
    console.error(
      "\nThis check exists because a cross-tenant leak ends the company.\n",
    );
    process.exit(1);
  }

  console.log(`\nRLS audit passed.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
