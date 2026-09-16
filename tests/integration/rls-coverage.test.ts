import { describe, expect, it } from "vitest";
import { prisma } from "@/db/client";

/**
 * Generated tenancy coverage.
 *
 * This does not read a hand-maintained list of tables — it reads the live
 * catalog. A table added in month six without an RLS policy fails here on the
 * day it is added, which is the only way the guarantee survives contact with a
 * deadline.
 *
 * scripts/audit-rls.ts runs the same checks in CI against DIRECT_URL. This one
 * exists so the failure also shows up in `npm run test:integration`, where a
 * developer meets it before pushing.
 */

const EXEMPT = new Set(["_prisma_migrations"]);

type TableRow = {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: bigint;
  has_org_column: boolean;
  references_tenant: boolean | null;
};

async function tables(): Promise<TableRow[]> {
  return prisma.$queryRaw<TableRow[]>`
    select c.relname              as table_name,
           c.relrowsecurity       as rls_enabled,
           c.relforcerowsecurity  as rls_forced,
           count(p.polname)       as policy_count,
           exists (
             select 1 from information_schema.columns col
             where col.table_schema = 'public'
               and col.table_name = c.relname
               and col.column_name = 'organization_id'
           )                      as has_org_column,
           bool_or(
             pg_get_expr(p.polqual, p.polrelid) ilike '%app_current_org%'
             or pg_get_expr(p.polwithcheck, p.polrelid) ilike '%app_current_org%'
           )                      as references_tenant
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_policy p on p.polrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
    group by c.relname, c.relrowsecurity, c.relforcerowsecurity, c.oid
    order by c.relname
  `;
}

describe("RLS coverage", () => {
  it("finds application tables at all", async () => {
    const rows = (await tables()).filter((t) => !EXEMPT.has(t.table_name));
    expect(
      rows.length,
      "No tables found — has the migration been applied?",
    ).toBeGreaterThan(0);
  });

  it("every table has row-level security ENABLED", async () => {
    const missing = (await tables())
      .filter((t) => !EXEMPT.has(t.table_name) && !t.rls_enabled)
      .map((t) => t.table_name);

    expect(
      missing,
      `These tables have no row-level security. Add them to prisma/rls.sql:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every table has row-level security FORCED", async () => {
    // Without FORCE, the table owner bypasses every policy on the table and the
    // whole mechanism is decorative.
    const missing = (await tables())
      .filter((t) => !EXEMPT.has(t.table_name) && !t.rls_forced)
      .map((t) => t.table_name);

    expect(
      missing,
      `These tables do not FORCE row-level security:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every table has at least one policy", async () => {
    const missing = (await tables())
      .filter((t) => !EXEMPT.has(t.table_name) && Number(t.policy_count) === 0)
      .map((t) => t.table_name);

    expect(
      missing,
      `RLS is on for these tables but no policy exists, which denies everything — a bug, not safety:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every table with organization_id has a policy that reads the tenant context", async () => {
    // A policy of `using (true)` satisfies the previous check and protects
    // nothing.
    const weak = (await tables())
      .filter(
        (t) =>
          !EXEMPT.has(t.table_name) &&
          t.has_org_column &&
          Number(t.policy_count) > 0 &&
          t.references_tenant !== true,
      )
      .map((t) => t.table_name);

    expect(
      weak,
      `These tables carry organization_id but no policy references app_current_org():\n  ${weak.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the connected role cannot bypass any of the above", async () => {
    const rows = await prisma.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `;
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });
});
