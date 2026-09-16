/**
 * Curriculum a test authors, and the one place that takes it away again.
 *
 * The curriculum plane has no tenant and this database is never reset, so a
 * test that authors a concept or an outcome as arrangement leaves it there for
 * every school to see. Before this existed the runs had left 1,514 concepts
 * named "Reporting concept 12 …" and "Sweeper …" beside 197 real ones, and
 * ~1,700 test outcomes inside real chapters (scripts/clean-test-curriculum.ts
 * removed them).
 *
 * The rule, for integration suites and smoke scripts alike:
 *
 *   - Author topics and outcomes only inside a FIXTURE CHAPTER — one numbered
 *     at or above FIXTURE_CHAPTER_FLOOR. No real syllabus has a chapter 1000,
 *     so the number is the marker; it needs no new column.
 *   - Concepts cannot live in a chapter, so a concept is cleaned up when it was
 *     created during the run AND measures nothing outside a fixture chapter.
 *     A concept an admin authored against real outcomes is never touched.
 *
 * Plain `pg` over DIRECT_URL, so the vitest global setup (which runs outside
 * the app's module graph) and the .mjs smoke scripts can share it.
 */

export const FIXTURE_CHAPTER_FLOOR = 1000;

/** A fixture chapter number: high enough to be no real chapter, random enough not to collide. */
export function fixtureChapterNumber() {
  return FIXTURE_CHAPTER_FLOOR + Math.floor(Math.random() * 1_000_000_000);
}

/**
 * The database clock, as UTC text.
 *
 * Text, not a Date, and that is load-bearing: `created_at` is `timestamp
 * WITHOUT time zone` holding UTC, and `pg` sends a JS Date in the machine's
 * local offset (+05:30 here). Casting that to a zoneless timestamp drops the
 * offset, so "since 12:24" was compared against rows stamped 06:54 and the
 * first teardown found none of the run's concepts.
 */
export async function databaseNow(db) {
  const { rows } = await db.query("select (now() at time zone 'UTC')::text as now");
  return rows[0].now;
}

/**
 * Remove every fixture chapter, and the concepts created since `since` that
 * measure nothing real. Returns what it removed.
 *
 * Every fixture chapter, not only this run's: chapters carry no timestamp, and
 * one left by a run that crashed before its teardown is junk all the same. The
 * cost is that two runs at once (an integration run beside a smoke run) can
 * pull a chapter out from under each other; run them one after the other.
 */
export async function removeFixtureCurriculum(db, since) {
  await db.query("begin");
  try {
    const outcomes = await db.query(
      `select o.id from learning_outcomes o
         join topics t on t.id = o.topic_id
         join chapters c on c.id = t.chapter_id
        where c.number >= $1`,
      [FIXTURE_CHAPTER_FLOOR],
    );
    const outcomeIds = outcomes.rows.map((r) => r.id);

    // question_outcomes has no foreign key to learning_outcomes.
    await db.query("delete from question_outcomes where learning_outcome_id = any($1::uuid[])", [outcomeIds]);
    await db.query("update questions set primary_outcome_id = null where primary_outcome_id = any($1::uuid[])", [outcomeIds]);
    const chapters = await db.query(
      "delete from chapters where number >= $1",
      [FIXTURE_CHAPTER_FLOOR],
    );

    // After the cascade, a run's concept linked only to fixture outcomes has no
    // links left — the same state as one that was never linked at all.
    const concepts = await db.query(
      `select c.id from concepts c
        where c.created_at >= $1::timestamp
          and not exists (select 1 from concept_outcomes co where co.concept_id = c.id)`,
      [since],
    );
    const conceptIds = concepts.rows.map((r) => r.id);
    // These carry concept_id with no foreign key, by design (CLAUDE.md, "There
    // is no delete"); left behind they would point at nothing.
    for (const table of ["student_mistakes", "learning_gaps", "student_concept_mastery", "concept_evidence"]) {
      await db.query(`delete from ${table} where concept_id = any($1::uuid[])`, [conceptIds]);
    }
    await db.query("delete from concepts where id = any($1::uuid[])", [conceptIds]);

    await db.query("commit");
    return { chapters: chapters.rowCount ?? 0, outcomes: outcomeIds.length, concepts: conceptIds.length };
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
