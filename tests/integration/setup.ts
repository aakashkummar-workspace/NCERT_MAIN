import { config } from "dotenv";
import { Client } from "pg";
import { beforeAll } from "vitest";
import { assertLocalDatabase } from "../../scripts/lib/local-database.mjs";

config({ path: ".env", quiet: true });

assertLocalDatabase("The integration suite");

/**
 * Integration tests run against a real Postgres with migrations and RLS
 * applied. They also run as `sahayak_app`, a role with no superuser and no
 * BYPASSRLS — because a superuser bypasses row-level security unconditionally,
 * and a tenancy test run as one passes while proving nothing.
 *
 * This guard is the difference between a test suite and a comfortable feeling.
 */
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, then run: npm run db:up && npm run db:migrate && npm run db:rls",
    );
  }

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Could not connect to Postgres at DATABASE_URL. Run: npm run db:up\n\n${String(error)}`,
    );
  }

  try {
    const { rows } = await client.query<{
      role: string;
      super: boolean;
      bypass: boolean;
    }>(
      `select current_user as role,
              (select rolsuper from pg_roles where rolname = current_user) as super,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypass`,
    );

    const row = rows[0];
    if (!row) throw new Error("Could not determine the connected role.");

    if (row.super || row.bypass) {
      throw new Error(
        `Integration tests are connected as "${row.role}", which ` +
          `${row.super ? "is a SUPERUSER" : "has BYPASSRLS"}. Row-level security ` +
          `is bypassed for this role, so every tenancy assertion below would ` +
          `pass without proving anything.\n\n` +
          `Point DATABASE_URL at the sahayak_app role — see .env.example — and ` +
          `run: npm run db:rls`,
      );
    }
  } finally {
    await client.end();
  }
});
