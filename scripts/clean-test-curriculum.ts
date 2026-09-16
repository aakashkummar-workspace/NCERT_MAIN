/**
 * Remove what test runs left on the shared curriculum plane.
 *
 *     npx tsx scripts/clean-test-curriculum.ts            # dry run
 *     npx tsx scripts/clean-test-curriculum.ts --commit
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The curriculum plane has no tenant, and this database is never reset, so
 * every suite that authored a concept, topic or outcome as arrangement left it
 * behind for every school to see: by September 2026 there were 1,514 concepts
 * named "Reporting concept 12 #…", "Sweeper #…" and "Smoke concept 3" beside
 * 197 real ones, and ~1,700 test outcomes inside real chapters.
 *
 * ---------------------------------------------------------------------------
 * Junk is defined by what is REAL, never by guessing at names
 * ---------------------------------------------------------------------------
 * Real = the chapter lists in prisma/curriculum.ts, the seeded worked example,
 * and prisma/curriculum-drafts/*.json. Anything else on CBSE's plane is removed:
 * concepts whose name is not real, outcomes and topics not real for their
 * chapter, chapters not in the list, and the "Unwritten Subject" fixtures.
 *
 * concept_evidence, student_concept_mastery, learning_gaps and student_mistakes
 * carry concept_id with NO foreign key (see CLAUDE.md, "There is no delete"),
 * so a concept delete would leave them pointing at nothing. They are removed in
 * the same transaction — and the script refuses outright if any of those rows,
 * or any question linked to a doomed outcome, belongs to an organization that
 * owns IMPORTED questions (the real bank) and is not soft-deleted. The ~36,000
 * test questions the Sep 11 bulk SQL moved into that organization are all
 * soft-deleted; they keep their rows and lose only links to dead outcomes.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { CHAPTERS, WORKED_EXAMPLE } from "../prisma/curriculum";

type Draft = {
  board: string;
  grade: number;
  subject: string;
  chapters: { number: number; topics: { title: string; outcomes: { code: string }[] }[]; concepts: { name: string }[] }[];
};

const commit = process.argv.includes("--commit");
const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const q = <T = Record<string, unknown>>(sql: string, ...args: unknown[]) => db.$queryRawUnsafe<T[]>(sql, ...args);

async function main() {
  // ---- The keep set --------------------------------------------------------
  const keepConcepts = new Set(WORKED_EXAMPLE.concepts.map((c) => c.name.toLowerCase()));
  const keepChapters = new Set<string>(); // grade|subjectCode|number
  const keepOutcomes = new Set<string>(); // chapterId|code
  const keepTopics = new Set<string>(); // chapterId|title

  for (const [grade, subjects] of Object.entries(CHAPTERS)) {
    for (const [code, chapters] of Object.entries(subjects)) {
      for (const c of chapters) keepChapters.add(`${grade}|${code}|${c.number}`);
    }
  }

  const chapterRows = await q<{ id: string; grade: number; code: string; subject: string; number: number }>(
    `select c.id, g.number as grade, s.code, s.name as subject, c.number
       from chapters c join subjects s on s.id = c.subject_id
       join grades g on g.id = s.grade_id join boards b on b.id = g.board_id
      where b.code = 'CBSE'`,
  );
  const chapterId = (grade: number, match: (r: (typeof chapterRows)[number]) => boolean, number: number) =>
    chapterRows.find((r) => r.grade === grade && r.number === number && match(r))?.id;

  const worked = chapterId(WORKED_EXAMPLE.gradeNumber, (r) => r.code === WORKED_EXAMPLE.subjectCode, WORKED_EXAMPLE.chapterNumber);
  if (!worked) throw new Error("Worked-example chapter not found.");
  for (const t of WORKED_EXAMPLE.topics) {
    keepTopics.add(`${worked}|${t.title}`);
    for (const o of t.outcomes) keepOutcomes.add(`${worked}|${o.code}`);
  }

  const dir = path.join("prisma", "curriculum-drafts");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const draft = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Draft;
    for (const ch of draft.chapters) {
      const id = chapterId(draft.grade, (r) => r.subject === draft.subject, ch.number);
      if (!id) throw new Error(`${file}: chapter ${ch.number} of ${draft.subject} not found — refusing to guess.`);
      for (const t of ch.topics) {
        keepTopics.add(`${id}|${t.title}`);
        for (const o of t.outcomes) keepOutcomes.add(`${id}|${o.code}`);
      }
      for (const k of ch.concepts) keepConcepts.add(k.name.toLowerCase());
    }
  }

  // ---- What goes -----------------------------------------------------------
  // Per-run fixture subjects from before the suites reused one: "Unwritten
  // Subject NOCH…" (readiness) and "Empty subject EMPTY…" (concept-suggest).
  const doomedSubjectRows = await q<{ id: string; grade_id: string }>(
    `select id, grade_id from subjects where code ~ '^(NOCH|EMPTY)[0-9A-F]{6}$'`,
  );
  const doomedSubjects = doomedSubjectRows.map((r) => r.id);
  const doomedChapters = chapterRows
    .filter((r) => !keepChapters.has(`${r.grade}|${r.code}|${r.number}`))
    .map((r) => r.id);

  const outcomeRows = await q<{ id: string; topic_id: string; chapter_id: string; code: string }>(
    `select o.id, o.topic_id, t.chapter_id, o.code from learning_outcomes o join topics t on t.id = o.topic_id`,
  );
  const cbseChapters = new Set(chapterRows.map((r) => r.id));
  const doomedChapterSet = new Set(doomedChapters);
  const doomedOutcomes = outcomeRows
    .filter((o) => cbseChapters.has(o.chapter_id))
    .filter((o) => doomedChapterSet.has(o.chapter_id) || !keepOutcomes.has(`${o.chapter_id}|${o.code}`))
    .map((o) => o.id);
  const doomedOutcomeSet = new Set(doomedOutcomes);
  const survivingByTopic = new Set(outcomeRows.filter((o) => !doomedOutcomeSet.has(o.id)).map((o) => o.topic_id));

  const topicRows = await q<{ id: string; chapter_id: string; title: string }>(`select id, chapter_id, title from topics`);
  const doomedTopics = topicRows
    .filter((t) => cbseChapters.has(t.chapter_id))
    .filter((t) => doomedChapterSet.has(t.chapter_id) || (!keepTopics.has(`${t.chapter_id}|${t.title}`) && !survivingByTopic.has(t.id)))
    .map((t) => t.id);

  const conceptRows = await q<{ id: string; name: string }>(`select id, name from concepts`);
  const doomedConcepts = conceptRows.filter((c) => !keepConcepts.has(c.name.toLowerCase())).map((c) => c.id);
  const keptConceptCount = conceptRows.length - doomedConcepts.length;

  // ---- The guard: the real bank must be untouched --------------------------
  const realOrgs = (await q<{ id: string }>(`select distinct organization_id as id from questions where source = 'IMPORTED' and organization_id is not null`)).map((r) => r.id);
  const offending = await q<{ what: string; n: number }>(
    `select 'question_outcomes' as what, count(*)::int as n from question_outcomes qo join questions x on x.id = qo.question_id
      where qo.learning_outcome_id = any($1::uuid[]) and x.organization_id = any($3::uuid[]) and x.deleted_at is null
     union all select 'questions in doomed chapters/subjects', count(*)::int from questions
      where (chapter_id = any($4::uuid[]) or subject_id = any($5::uuid[])) and organization_id = any($3::uuid[]) and deleted_at is null
     union all select 'classes on doomed subjects', count(*)::int from classes
      where subject_id = any($5::uuid[]) and organization_id = any($3::uuid[])
     union all select 'concept_evidence', count(*)::int from concept_evidence where concept_id = any($2::uuid[]) and organization_id = any($3::uuid[])
     union all select 'student_concept_mastery', count(*)::int from student_concept_mastery where concept_id = any($2::uuid[]) and organization_id = any($3::uuid[])`,
    doomedOutcomes, doomedConcepts, realOrgs, doomedChapters, doomedSubjects,
  );

  const orphanCount = async (table: string) =>
    (await q<{ n: number }>(`select count(*)::int as n from ${table} where concept_id = any($1::uuid[])`, doomedConcepts))[0]!.n;

  console.log(`\nClean test curriculum — ${commit ? "COMMIT" : "dry run"}`);
  console.log(`  concepts        ${doomedConcepts.length} to remove, ${keptConceptCount} kept`);
  console.log(`  outcomes        ${doomedOutcomes.length} to remove, ${outcomeRows.length - doomedOutcomes.length} kept`);
  console.log(`  topics          ${doomedTopics.length} to remove`);
  console.log(`  chapters        ${doomedChapters.length} to remove`);
  console.log(`  subjects        ${doomedSubjects.length} to remove (per-run fixture subjects; test-org references move to ZZNOCHAPTERS)`);
  for (const t of ["concept_evidence", "student_concept_mastery", "learning_gaps", "student_mistakes"]) {
    console.log(`  ${t.padEnd(24)} ${await orphanCount(t)} test-org rows to remove`);
  }
  const blocked = offending.filter((o) => o.n > 0);
  for (const o of blocked) console.log(`  REFUSED  ${o.n} ${o.what} belong to the real bank`);
  if (blocked.length) {
    process.exitCode = 1;
    return;
  }
  if (!commit) {
    console.log("\nNothing written. Re-run with --commit to apply.");
    return;
  }

  await db.$transaction(
    async (tx) => {
      const x = (sql: string, ...args: unknown[]) => tx.$executeRawUnsafe(sql, ...args);
      // Tenant rows first: no foreign key will do it for us.
      await x(`delete from student_mistakes where concept_id = any($1::uuid[])`, doomedConcepts);
      await x(`delete from learning_gaps where concept_id = any($1::uuid[])`, doomedConcepts);
      await x(`delete from student_concept_mastery where concept_id = any($1::uuid[])`, doomedConcepts);
      await x(`delete from concept_evidence where concept_id = any($1::uuid[])`, doomedConcepts);
      await x(`delete from concepts where id = any($1::uuid[])`, doomedConcepts);

      // Test questions filed under doomed curriculum lose the link, not the row.
      await x(`delete from question_outcomes where learning_outcome_id = any($1::uuid[])`, doomedOutcomes);
      await x(`update questions set primary_outcome_id = null where primary_outcome_id = any($1::uuid[])`, doomedOutcomes);
      await x(`delete from learning_outcomes where id = any($1::uuid[])`, doomedOutcomes);
      await x(`delete from topics where id = any($1::uuid[])`, doomedTopics);
      await x(`delete from chapters where id = any($1::uuid[])`, doomedChapters);

      // A per-run subject still referenced by a test org's class, question or
      // paper: the references move to the one reusable fixture subject of the
      // same grade — every row of one class, paper and question moves together,
      // so they still share a subject — and the per-run subject goes.
      for (const gradeId of new Set(doomedSubjectRows.map((r) => r.grade_id))) {
        const ids = doomedSubjectRows.filter((r) => r.grade_id === gradeId).map((r) => r.id);
        const [target] = await tx.$queryRawUnsafe<{ id: string }[]>(
          `insert into subjects (id, grade_id, code, name, short_name)
           values (gen_random_uuid(), $1::uuid, 'ZZNOCHAPTERS', 'Test fixture – no chapters', 'Test fixture')
           on conflict (grade_id, code) do update set code = excluded.code
           returning id`,
          gradeId,
        );
        for (const table of ["classes", "questions", "assessments"]) {
          await x(`update ${table} set subject_id = $1::uuid where subject_id = any($2::uuid[])`, target!.id, ids);
        }
      }
      const gone = await x(`delete from subjects where id = any($1::uuid[])`, doomedSubjects);
      console.log(`  subjects removed ${gone} of ${doomedSubjects.length}`);
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  console.log("\nDone.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
