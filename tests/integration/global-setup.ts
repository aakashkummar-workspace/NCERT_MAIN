import { config } from "dotenv";
import { Client } from "pg";
import { assertLocalDatabase } from "../../scripts/lib/local-database.mjs";
import { databaseNow, removeFixtureCurriculum } from "../../scripts/lib/fixture-curriculum.mjs";

/**
 * Takes away the curriculum this run authored, once, after every suite.
 *
 * The curriculum plane has no tenant and the database is never reset, so what
 * a suite writes there is permanent and global unless something removes it.
 * Per-suite `afterAll` cleanup would be twenty places to forget; this is one.
 * See scripts/lib/fixture-curriculum.mjs for exactly what counts as a fixture.
 */
export default async function setup() {
  config({ path: ".env", quiet: true });
  assertLocalDatabase("The integration suite");
  const url = process.env.DIRECT_URL;
  if (!url) return;

  const db = new Client({ connectionString: url });
  await db.connect();
  const since = await databaseNow(db);
  await db.end();

  return async function teardown() {
    const cleanup = new Client({ connectionString: url });
    await cleanup.connect();
    try {
      const removed = await removeFixtureCurriculum(cleanup, since);
      console.log(
        `fixture curriculum removed: ${removed.chapters} chapters, ${removed.outcomes} outcomes, ${removed.concepts} concepts`,
      );
    } finally {
      await cleanup.end();
    }
  };
}
