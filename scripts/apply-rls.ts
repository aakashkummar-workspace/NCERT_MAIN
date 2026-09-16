import "dotenv/config";
/**
 * Applies prisma/rls.sql through DIRECT_URL (the superuser connection).
 *
 * Run after every schema migration. Idempotent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { pgConfig } from "./lib/pg-connection";

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) {
    console.error("DIRECT_URL is not set. Copy .env.example to .env.");
    process.exit(1);
  }

  const sql = readFileSync(join(process.cwd(), "prisma", "rls.sql"), "utf8");
  const client = new Client(pgConfig(url));
  await client.connect();

  try {
    await client.query("begin");
    await client.query(sql);

    // The role password lives in the environment, not in the SQL file.
    const password = process.env.APP_DB_PASSWORD;
    if (password) {
      await client.query(
        `alter role sahayak_app login password '${password.replace(/'/g, "''")}'`,
      );
    }

    const platformPassword = process.env.PLATFORM_DB_PASSWORD;
    if (platformPassword) {
      await client.query(
        `alter role sahayak_platform login password '${platformPassword.replace(/'/g, "''")}'`,
      );
    }

    await client.query("commit");
    console.log("RLS policies applied.");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
