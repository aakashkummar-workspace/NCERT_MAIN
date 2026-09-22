import "dotenv/config";
import { Client } from "pg";
import { CHAPTERS, CHAPTER_SOURCE, WORKED_EXAMPLE } from "./curriculum";

/**
 * Seeds the head of the curriculum plane: the boards, their Class 9 and 10,
 * and the subjects each offers.
 *
 * Runs over DIRECT_URL because the app role has no write grant on these tables
 * — deliberately. Shared curriculum ids are what make "Mathematics" the same
 * row in every tenant, and a tenant that could write here would break that for
 * everybody.
 *
 * Idempotent: safe to run on every deploy.
 */

type SubjectSeed = {
  code: string;
  name: string;
  shortName: string;
  /** Only these class years. Absent means both. */
  grades?: number[];
  /** A different name in one class year, keyed by grade number. */
  names?: Record<number, { name: string; shortName: string }>;
};

/**
 * Class 10 English and Social Science are one examination each but several
 * books, each numbering its chapters from 1. Filed as one subject, the
 * question importer put "Footprints ch1" into "First Flight ch1" and History,
 * Economics and Political Science into the Geography chapters — about 730
 * questions under the wrong chapter with nothing looking wrong. So in Class 10
 * every book is its own subject. The existing ENG and SST codes keep the books
 * they already held (First Flight, Geography), so nothing that points at them
 * changes meaning. Class 9's new books are single integrated volumes and stay
 * one subject each.
 */
const CBSE_SUBJECTS: SubjectSeed[] = [
  { code: "MATH", name: "Mathematics", shortName: "Maths" },
  { code: "SCI", name: "Science", shortName: "Science" },
  {
    code: "SST",
    name: "Social Science",
    shortName: "Social",
    names: { 10: { name: "Social Science – Geography", shortName: "Geography" } },
  },
  { code: "SSTEC", name: "Social Science – Economics", shortName: "Economics", grades: [10] },
  { code: "SSTHI", name: "Social Science – History", shortName: "History", grades: [10] },
  { code: "SSTPS", name: "Social Science – Political Science", shortName: "Politics", grades: [10] },
  {
    code: "ENG",
    name: "English",
    shortName: "English",
    names: { 10: { name: "English – First Flight", shortName: "First Flight" } },
  },
  { code: "ENGFP", name: "English – Footprints without Feet", shortName: "Footprints", grades: [10] },
  // Class 10 Hindi is two courses and a student takes one: Course A (Kshitij,
  // Kritika) keeps the HIN code, Course B (Sparsh, Sanchayan) is its own
  // subject — the same one-course-one-subject rule as the English books.
  {
    code: "HIN",
    name: "Hindi",
    shortName: "Hindi",
    names: { 10: { name: "Hindi A", shortName: "Hindi A" } },
  },
  { code: "HINB", name: "Hindi B", shortName: "Hindi B", grades: [10] },
  // Section B of the CBSE English (184) paper — grammar and writing — belongs
  // to no textbook chapter, so it is its own subject with a chapter per
  // syllabus item. Last in the list so no existing subject's sort order moves.
  // A consequence to know: a paper holds one subject, so grammar questions are
  // set in their own paper rather than inside a First Flight one.
  {
    code: "ENGGW",
    name: "English – Grammar and Writing",
    shortName: "Grammar & Writing",
  },
];

/**
 * ICSE — the SHAPE only, and that is the whole of what is claimed here.
 *
 * ---------------------------------------------------------------------------
 * What is seeded, and what deliberately is not
 * ---------------------------------------------------------------------------
 * A board, its Class 9 and Class 10, and the subject names a Class 9/10 ICSE
 * candidate sits. Those are a matter of public record, checkable against the
 * CISCE regulations in about a minute, and they are exactly what the product
 * needs to let an ICSE school sign up, create a class and be a real tenant.
 *
 * NOT here: a single chapter, topic or learning outcome. ICSE's syllabus is
 * per-subject and per-year and it is not the NCERT contents page; inventing
 * one would be precisely the guess this product refuses everywhere else, and
 * the invention would be invisible — a plausible chapter list is the hardest
 * kind of wrong to notice, and every generated question and every mastery
 * figure downstream would inherit it.
 *
 * So an ICSE school today gets classes, a roster, a question bank they author
 * themselves and everything the tenant plane does. What they do NOT get is
 * chapter-grounded generation, outcome-backed mastery, gaps, practice or term
 * reports — all of which need outcomes, which are authored at /x/curriculum by
 * somebody who teaches the subject. That is the same visible, designed hole
 * the 50 bare CBSE chapters already sit in, one level further up the tree.
 */
const ICSE_SUBJECTS: SubjectSeed[] = [
  { code: "MATH", name: "Mathematics", shortName: "Maths" },
  { code: "PHY", name: "Physics", shortName: "Physics" },
  { code: "CHEM", name: "Chemistry", shortName: "Chemistry" },
  { code: "BIO", name: "Biology", shortName: "Biology" },
  { code: "HCG", name: "History, Civics and Geography", shortName: "HCG" },
  { code: "ENG", name: "English", shortName: "English" },
];

const BOARDS: {
  code: string;
  name: string;
  country: string;
  subjects: SubjectSeed[];
}[] = [
  {
    code: "CBSE",
    name: "Central Board of Secondary Education",
    country: "IN",
    subjects: CBSE_SUBJECTS,
  },
  {
    code: "ICSE",
    name: "Indian Certificate of Secondary Education",
    country: "IN",
    subjects: ICSE_SUBJECTS,
  },
];

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set.");

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query("begin");

    for (const board of BOARDS) {
      const saved = await client.query<{ id: string }>(
        `insert into boards (id, code, name, country)
         values (gen_random_uuid(), $1, $2, $3)
         on conflict (code) do update set name = excluded.name
         returning id`,
        [board.code, board.name, board.country],
      );
      const boardId = saved.rows[0]!.id;

      for (const number of [9, 10]) {
        const grade = await client.query<{ id: string }>(
          `insert into grades (id, board_id, number, label)
           values (gen_random_uuid(), $1, $2, $3)
           on conflict (board_id, number) do update set label = excluded.label
           returning id`,
          [boardId, number, `Class ${number}`],
        );
        const gradeId = grade.rows[0]!.id;

        for (const [index, subject] of board.subjects.entries()) {
          if (subject.grades && !subject.grades.includes(number)) continue;
          const named = subject.names?.[number] ?? subject;
          await client.query(
            `insert into subjects (id, grade_id, code, name, short_name, sort_order)
             values (gen_random_uuid(), $1, $2, $3, $4, $5)
             on conflict (grade_id, code) do update
               set name = excluded.name,
                   short_name = excluded.short_name,
                   sort_order = excluded.sort_order`,
            [gradeId, subject.code, named.name, named.shortName, index],
          );
        }
      }
    }

    await seedChapters(client);
    await seedWorkedExample(client);
    await seedPlans(client);

    await client.query("commit");

    const counts = await client.query<{
      grades: string;
      subjects: string;
      chapters: string;
      topics: string;
      outcomes: string;
      concepts: string;
      bare: string;
    }>(
      `select (select count(*) from grades)::text            as grades,
              (select count(*) from subjects)::text          as subjects,
              (select count(*) from chapters)::text          as chapters,
              (select count(*) from topics)::text            as topics,
              (select count(*) from learning_outcomes)::text as outcomes,
              (select count(*) from concepts)::text          as concepts,
              (select count(*) from chapters c
                where not exists (select 1 from topics t where t.chapter_id = c.id))::text as bare`,
    );
    const row = counts.rows[0]!;
    console.log(
      `Curriculum seeded: ${BOARDS.map((b) => b.code).join(" and ")}, ` +
        `${row.grades} grades, ${row.subjects} subjects, ` +
        `${row.chapters} chapters, ${row.topics} topics, ${row.outcomes} outcomes, ` +
        `${row.concepts} concepts.`,
    );
    console.log(
      `${row.bare} chapters have no learning outcomes yet. That is expected: an ` +
        `outcome statement is prompt material, not a label, and inventing them ` +
        `would be the guess this product refuses. Author them at /x/curriculum.`,
    );
    console.log(
      `ICSE is seeded as a SHAPE only: the board, Class 9 and 10, and the ` +
        `subject names. No chapters, no topics, no outcomes — an ICSE syllabus ` +
        `is authored by somebody who teaches it, and a plausible invented one ` +
        `is the hardest kind of wrong to notice. An ICSE school can create ` +
        `classes and author its own questions today; grounded generation, ` +
        `mastery, gaps and reports need outcomes first.`,
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

async function seedChapters(client: Client) {
  for (const [gradeNumber, subjects] of Object.entries(CHAPTERS)) {
    for (const [subjectCode, chapters] of Object.entries(subjects)) {
      // Scoped to CBSE by board code, not just by grade number. Two boards
      // now have a Class 10 and a subject coded MATH, and a lookup that only
      // matched those would seed the NCERT chapter list into whichever row came
      // back first — a wrong syllabus that looks exactly like a right one.
      const subject = await client.query<{ id: string }>(
        `select s.id from subjects s
         join grades g on g.id = s.grade_id
         join boards b on b.id = g.board_id
         where b.code = 'CBSE' and g.number = $1 and s.code = $2`,
        [Number(gradeNumber), subjectCode],
      );
      const subjectId = subject.rows[0]?.id;
      if (!subjectId) continue;

      for (const chapter of chapters) {
        await client.query(
          `insert into chapters (id, subject_id, number, title, source, sort_order)
           values (gen_random_uuid(), $1, $2, $3, $4, $2)
           on conflict (subject_id, number) do update
             set title = excluded.title, source = excluded.source`,
          [subjectId, chapter.number, chapter.title, CHAPTER_SOURCE],
        );
      }
    }
  }
}

/**
 * One chapter authored end to end, so the shape of a good outcome statement is
 * in the database from day one rather than described in a document nobody
 * opens. It is also what the curriculum editor is tested against.
 */
async function seedWorkedExample(client: Client) {
  const chapter = await client.query<{ id: string }>(
    `select c.id from chapters c
     join subjects s on s.id = c.subject_id
     join grades g on g.id = s.grade_id
     join boards b on b.id = g.board_id
     where b.code = 'CBSE' and g.number = $1 and s.code = $2 and c.number = $3`,
    [
      WORKED_EXAMPLE.gradeNumber,
      WORKED_EXAMPLE.subjectCode,
      WORKED_EXAMPLE.chapterNumber,
    ],
  );
  const chapterId = chapter.rows[0]?.id;
  if (!chapterId) return;

  const outcomeIdByCode = new Map<string, string>();

  for (const [index, topic] of WORKED_EXAMPLE.topics.entries()) {
    const existing = await client.query<{ id: string }>(
      `select id from topics where chapter_id = $1 and title = $2`,
      [chapterId, topic.title],
    );
    const topicId =
      existing.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          `insert into topics (id, chapter_id, title, sort_order)
           values (gen_random_uuid(), $1, $2, $3) returning id`,
          [chapterId, topic.title, index],
        )
      ).rows[0]!.id;

    for (const [position, outcome] of topic.outcomes.entries()) {
      const saved = await client.query<{ id: string }>(
        `insert into learning_outcomes
           (id, topic_id, code, statement, bloom_level, competency,
            typical_marks, sort_order, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $4::"BloomLevel", $5::"Competency", $6, $7, now())
         on conflict (topic_id, code) do update
           set statement = excluded.statement,
               bloom_level = excluded.bloom_level,
               competency = excluded.competency,
               typical_marks = excluded.typical_marks,
               updated_at = now()
         returning id`,
        [
          topicId,
          outcome.code,
          outcome.statement,
          outcome.bloomLevel,
          outcome.competency,
          outcome.typicalMarks,
          position,
        ],
      );
      outcomeIdByCode.set(outcome.code, saved.rows[0]!.id);
    }
  }

  const conceptIdBySlug = new Map<string, string>();

  for (const concept of WORKED_EXAMPLE.concepts) {
    const saved = await client.query<{ id: string }>(
      `insert into concepts (id, slug, name, description)
       values (gen_random_uuid(), $1, $2, $3)
       on conflict (slug) do update
         set name = excluded.name, description = excluded.description
       returning id`,
      [concept.slug, concept.name, concept.description],
    );
    const conceptId = saved.rows[0]!.id;
    conceptIdBySlug.set(concept.slug, conceptId);

    for (const code of concept.outcomeCodes) {
      const outcomeId = outcomeIdByCode.get(code);
      if (!outcomeId) continue;
      await client.query(
        `insert into concept_outcomes (concept_id, learning_outcome_id, weight)
         values ($1, $2, 1.0) on conflict do nothing`,
        [conceptId, outcomeId],
      );
    }
  }

  for (const concept of WORKED_EXAMPLE.concepts) {
    for (const slug of concept.prerequisiteSlugs ?? []) {
      const conceptId = conceptIdBySlug.get(concept.slug);
      const prerequisiteId = conceptIdBySlug.get(slug);
      if (!conceptId || !prerequisiteId || conceptId === prerequisiteId) continue;
      await client.query(
        `insert into concept_prerequisites (concept_id, prerequisite_concept_id, strength)
         values ($1, $2, 1.0) on conflict do nothing`,
        [conceptId, prerequisiteId],
      );
    }
  }
}

/**
 * The plans, from PRODUCT_REQUIREMENTS section 6.
 *
 * Seeded rather than hard-coded, because that is the whole point: adding a
 * plan, moving a limit or running a promotion is data. Prices are in paise, so
 * the smallest unit is the only one stored and nothing ever rounds.
 *
 * Institute and School carry no public price — they are negotiated, and a
 * number here would be a number somebody quotes.
 */
const PLANS: {
  code: string;
  name: string;
  pricePaise: number;
  isPublic: boolean;
  entitlements: { key: string; limit: number; unlimited?: boolean }[];
}[] = [
  {
    code: "free",
    name: "Free",
    pricePaise: 0,
    isPublic: true,
    entitlements: [
      { key: "max_classes", limit: 1 },
      { key: "max_students", limit: 30 },
      { key: "ai_generations_per_month", limit: 5 },
      // No `copilot_questions_per_month` row at all. A missing entitlement is
      // "not included", never "unlimited" — and the Copilot is the one DEEP-tier
      // feature, at roughly forty times the cost of a classification call.
      // No `tutor_hints_per_month` either, and for the opposite reason: it is
      // cheap per call and metered per student, so on a free plan its cost
      // scales with the users who pay nothing. RISKS.md §12.
      // Boolean capabilities are `unlimited`, never `limit: 1`. A limit of one
      // is a real count — "one class" — and conflating the two made the
      // settings page tell a teacher on Free that classes were "Included".
      { key: "analytics", limit: 0, unlimited: true },
    ],
  },
  {
    code: "teacher_pro",
    name: "Teacher Pro",
    pricePaise: 49900,
    isPublic: true,
    entitlements: [
      { key: "max_classes", limit: 5 },
      { key: "max_students", limit: 200 },
      { key: "ai_generations_per_month", limit: 100 },
      // Metered on its own key, not against generations. A teacher's question
      // to the Copilot must not eat the allowance they bought to write papers
      // with — two different promises, and conflating them means a teacher who
      // asked five questions cannot set a test.
      { key: "copilot_questions_per_month", limit: 50 },
      // The tutor is the one feature metered per STUDENT while the plan is
      // priced per teacher, so its ceiling is set against the roster, not the
      // buyer: 200 students, roughly two or three asks each in a month. There
      // is a per-student daily cap in `core/tutor` on top of this, because a
      // shared allowance one student can spend in an afternoon is not a limit,
      // it is a race.
      { key: "tutor_hints_per_month", limit: 500 },
      // Drafted marks for written answers. Its own key, for the Copilot's
      // reason: a teacher who drafts marks for a stack of scripts must not
      // find they can no longer generate a paper. Priced against the marking
      // it saves — two hundred students, a written question or two each a
      // month. Free has no row: a draft reads a photograph, which is not the
      // cheap end of what a model costs.
      { key: "ai_marking_per_month", limit: 300 },
      { key: "analytics", limit: 0, unlimited: true },
      { key: "parent_reports", limit: 0, unlimited: true },
    ],
  },
  {
    code: "institute",
    name: "Institute",
    // Per student per month, negotiated. Zero here is not "free" — it is "not
    // quoted on a page", which is what isPublic false says.
    pricePaise: 0,
    isPublic: false,
    entitlements: [
      { key: "max_classes", limit: 0, unlimited: true },
      { key: "max_students", limit: 0, unlimited: true },
      { key: "ai_generations_per_month", limit: 1000 },
      { key: "copilot_questions_per_month", limit: 300 },
      { key: "tutor_hints_per_month", limit: 5000 },
      { key: "ai_marking_per_month", limit: 3000 },
      { key: "analytics", limit: 0, unlimited: true },
      { key: "parent_reports", limit: 0, unlimited: true },
      { key: "admin_console", limit: 0, unlimited: true },
      // The school's own name, logo, colours and letterhead. On the plan that
      // has the console it is edited from; which plans include it is data.
      { key: "white_label", limit: 0, unlimited: true },
    ],
  },
];

async function seedPlans(client: Client) {
  for (const [index, plan] of PLANS.entries()) {
    const saved = await client.query<{ id: string }>(
      `insert into plans (id, code, name, price_paise, interval, is_public, sort_order)
       values (gen_random_uuid(), $1, $2, $3, 'MONTH', $4, $5)
       on conflict (code) do update
         set name = excluded.name,
             price_paise = excluded.price_paise,
             is_public = excluded.is_public,
             sort_order = excluded.sort_order
       returning id`,
      [plan.code, plan.name, plan.pricePaise, plan.isPublic, index],
    );
    const planId = saved.rows[0]!.id;

    for (const entitlement of plan.entitlements) {
      await client.query(
        `insert into entitlements (id, plan_id, key, limit_value, unlimited)
         values (gen_random_uuid(), $1, $2, $3, $4)
         on conflict (plan_id, key) do update
           set limit_value = excluded.limit_value,
               unlimited = excluded.unlimited`,
        [planId, entitlement.key, entitlement.limit, entitlement.unlimited ?? false],
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
