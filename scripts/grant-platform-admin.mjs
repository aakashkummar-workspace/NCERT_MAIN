/**
 * Grants (or revokes) platform-admin on an account.
 *
 *   node scripts/grant-platform-admin.mjs someone@example.com
 *   node scripts/grant-platform-admin.mjs someone@example.com --revoke
 *
 * Runs over DIRECT_URL: this is an operator action, not something the product
 * can do to itself. There is deliberately no in-app way to promote an account.
 */
import "dotenv/config";
import pg from "pg";

const email = process.argv[2];
const revoke = process.argv.includes("--revoke");

if (!email) {
  console.error("Usage: node scripts/grant-platform-admin.mjs <email> [--revoke]");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DIRECT_URL });
await client.connect();

try {
  const { rowCount, rows } = await client.query(
    `update users set platform_admin = $2
     where lower(email) = lower($1) and deleted_at is null
     returning id, full_name, platform_admin`,
    [email, !revoke],
  );

  if (rowCount === 0) {
    console.error(`No account found for ${email}.`);
    process.exit(1);
  }

  const user = rows[0];
  console.log(
    `${user.full_name} (${email}) ${user.platform_admin ? "is now" : "is no longer"} a platform admin.`,
  );
} finally {
  await client.end();
}
