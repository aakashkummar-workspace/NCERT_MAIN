/**
 * Add CBSE "English – Grammar and Writing" (ENGGW) and its chapters to a
 * database that already holds the rest of the curriculum.
 *
 *     npx tsx scripts/add-grammar-writing-subject.ts           # dry run
 *     npx tsx scripts/add-grammar-writing-subject.ts --commit
 *
 * ---------------------------------------------------------------------------
 * Why not `npm run db:seed`
 * ---------------------------------------------------------------------------
 * The seed would add this subject too — it is in prisma/seed.ts and its
 * chapters in prisma/curriculum.ts, which is where they must live so a later
 * seed keeps them. But the seed also upserts every plan and entitlement from
 * code, and on a live database a price or a limit changed as data would be
 * quietly put back. This touches one subject and its chapters, nothing else.
 *
 * Same SQL shape as the seed (insert … on conflict do update), so running it
 * twice changes nothing, and the chapter titles come from CHAPTERS itself.
 */
import "dotenv/config";
import { Client } from "pg";
import { CHAPTERS, CHAPTER_SOURCE } from "../prisma/curriculum";

const CODE = "ENGGW";
const NAME = "English – Grammar and Writing";
const SHORT_NAME = "Grammar & Writing";
/** Its index in CBSE_SUBJECTS in prisma/seed.ts, which is what the seed stamps. */
const SORT_ORDER = 10;

async function main() {
  const commit = process.argv.includes("--commit");
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set.");
  // `sslmode` out of the URL and TLS configured here, as migrate-to-supabase.mjs
  // does: with it in the string pg verifies the pooler's chain and refuses. A
  // local database has no TLS at all.
  const parsed = new URL(url);
  const remote = parsed.searchParams.get("sslmode") === "require";
  parsed.searchParams.delete("sslmode");
  for (const key of ["connection_limit", "pool_timeout"]) parsed.searchParams.delete(key);
  const client = new Client({
    connectionString: parsed.toString(),
    ssl: remote ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    await client.query("begin");
    for (const grade of ["9", "10"]) {
      const chapters = CHAPTERS[grade]?.[CODE];
      if (!chapters?.length) throw new Error(`prisma/curriculum.ts has no ${CODE} chapters for Class ${grade}`);

      const gradeRow = await client.query<{ id: string }>(
        `select g.id from grades g join boards b on b.id = g.board_id
         where b.code = 'CBSE' and g.number = $1`,
        [Number(grade)],
      );
      const gradeId = gradeRow.rows[0]?.id;
      if (!gradeId) throw new Error(`no CBSE Class ${grade}`);

      const subject = await client.query<{ id: string }>(
        `insert into subjects (id, grade_id, code, name, short_name, sort_order)
         values (gen_random_uuid(), $1, $2, $3, $4, $5)
         on conflict (grade_id, code) do update
           set name = excluded.name, short_name = excluded.short_name, sort_order = excluded.sort_order
         returning id`,
        [gradeId, CODE, NAME, SHORT_NAME, SORT_ORDER],
      );
      const subjectId = subject.rows[0]!.id;

      for (const chapter of chapters) {
        await client.query(
          `insert into chapters (id, subject_id, number, title, source, sort_order)
           values (gen_random_uuid(), $1, $2, $3, $4, $2)
           on conflict (subject_id, number) do update
             set title = excluded.title, source = excluded.source`,
          [subjectId, chapter.number, chapter.title, CHAPTER_SOURCE],
        );
      }
      console.log(`CBSE Class ${grade}: ${NAME} with ${chapters.length} chapters — ${chapters.map((c) => c.title).join(", ")}`);
    }
    await client.query(commit ? "commit" : "rollback");
    console.log(commit ? "\nCommitted." : "\nDry run: rolled back. Re-run with --commit to apply.");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
