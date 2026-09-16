/**
 * Mock analytics for a demo school: weekly papers, sittings, mastery, gaps
 * and term reports — all through core, so every figure is one the product
 * computed rather than one typed in.
 *
 *   npx tsx --conditions=react-server scripts/seed-mock-analytics.mts
 *
 * The school and class are constants below (SLUG, CLASS): this writes real
 * rows into whichever database .env points at, so it names its target rather
 * than taking one from an argument by accident.
 *
 * It is RESUMABLE. A run that dies mid-paper is re-run: papers already sat
 * are only re-dated, and students who missed one sit it.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { pgConfig } from "./scripts/lib/pg-connection.ts";

const { createAssessment, setQuestions, publishAssessment } = await import("./src/core/assessments/index.ts");
const { createAssignment } = await import("./src/core/assignments/index.ts");
const { startAttempt, getPlayer, saveAnswers, submitAttempt } = await import("./src/core/attempts/index.ts");
const { rebuildMastery } = await import("./src/core/mastery/sync.ts");
const { detectForClass } = await import("./src/core/gaps/detect.ts");
const { generateForClass } = await import("./src/core/reports/index.ts");

const SLUG = "sirah-digital-ea8a1";
const CLASS = "Class 10-A";
const DAY = 86_400_000;

// Seeded RNG, so a re-run of the plan is the same plan.
let seed = 20260915;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// A pool, not one client: the first run lost its single connection after an
// hour and died. A pool replaces a dropped idle connection on the next query.
const db = new pg.Pool({ ...pgConfig(process.env.DIRECT_URL!), max: 2, idleTimeoutMillis: 20_000 });
db.on("error", (error) => console.log("pool connection dropped (replaced):", error.message));

const ctx = (await db.query(
  `select o.id org, k.id class, k.subject_id subject, s.grade_id grade, u.id owner
     from organizations o
     join classes k on k.organization_id = o.id and k.name = $2 and k.deleted_at is null
     join subjects s on s.id = k.subject_id
     join memberships m on m.organization_id = o.id and m.role = 'OWNER'
     join users u on u.id = m.user_id
    where o.slug = $1 limit 1`, [SLUG, CLASS])).rows[0];
if (!ctx) throw new Error("class not found");

// Timestamps here are `timestamp without time zone` holding UTC. A JS Date is
// sent with the machine's +05:30 offset and the cast drops it, so send UTC text.
const utc = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

const students = (await db.query(
  `select u.id, u.full_name from class_enrolments e join users u on u.id = e.student_user_id
    where e.class_id = $1 and e.status = 'ACTIVE' order by u.full_name`, [ctx.class])).rows as { id: string; full_name: string }[];
console.log(`students: ${students.length}`);

const teacher = { organizationId: ctx.org, userId: ctx.owner, role: "OWNER" };

// chapter number, weeks ago, how hard the class finds it (added to ability)
const PAPERS: [number, number, number][] = [
  [1, 6, 0.08],   // Real Numbers — comfortable
  [2, 5, 0.0],    // Polynomials
  [3, 4, -0.05],  // Linear equations
  [4, 3, -0.3],   // Quadratic equations — the class-wide gap
  [5, 2, 0.02],   // Arithmetic progressions
  [8, 1, -0.12],  // Trigonometry — shaky
];
const DIFF_ADJ: Record<string, number> = { EASY: 0.12, MEDIUM: 0, HARD: -0.18 };

// Each student: a base ability, and a personal weak chapter for some.
const ability = new Map(students.map((s, i) => {
  const struggler = i % 7 === 3;               // three students who find everything hard
  const base = struggler ? 0.32 + rand() * 0.1 : 0.55 + rand() * 0.35;
  const weakChapter = rand() < 0.4 ? PAPERS[Math.floor(rand() * PAPERS.length)]![0] : null;
  return [s.id, { base, weakChapter }];
}));
// Two absences, so the analytics has denominators to state.
const absent = new Set([`${students[5]?.id}:5`, `${students[12]?.id}:8`]);

const clamp = (x: number) => Math.max(0.05, Math.min(0.97, x));

/** Each listed student sits the paper once, answering to their ability. */
async function sitPaper(
  assessmentId: string,
  assignmentId: string,
  list: { id: string; full_name: string }[],
  chapterNumber: number,
  classAdj: number,
) {
  // The keys and difficulties, from the frozen versions the paper was published with.
  const rows = (await db.query(
    `select aq.id, v.options, q.difficulty from assessment_questions aq
       join question_versions v on v.id = aq.question_version_id
       join questions q on q.id = aq.question_id
      where aq.assessment_id = $1`, [assessmentId])).rows;
  const byAq = new Map(rows.map((r) => [r.id, r]));

  let sat = 0, correct = 0, answered = 0;
  for (const student of list) {
    const actor = { organizationId: ctx.org, userId: student.id };
    const started = await startAttempt(actor, assignmentId, randomUUID());
    if (!started.ok) throw new Error(`${student.full_name}: ${started.message}`);
    const player = await getPlayer(actor, started.attemptId);
    const me = ability.get(student.id)!;
    const patches = player!.questions.map((question, index) => {
      const row = byAq.get(question.assessmentQuestionId);
      const options = (row?.options ?? []) as { key: string; isCorrect: boolean }[];
      const right = options.filter((o) => o.isCorrect).map((o) => o.key);
      const wrong = options.filter((o) => !o.isCorrect).map((o) => o.key);
      const p = clamp(me.base + classAdj + (DIFF_ADJ[row?.difficulty] ?? 0)
        + (me.weakChapter === chapterNumber ? -0.25 : 0));
      const isRight = rand() < p;
      correct += isRight ? 1 : 0; answered++;
      const key = isRight || wrong.length === 0 ? right[0]! : wrong[Math.floor(rand() * wrong.length)]!;
      return { assessmentQuestionId: question.assessmentQuestionId, response: { kind: "choice" as const, keys: [key] }, clientSeq: index + 1 };
    });
    await saveAnswers(actor, started.attemptId, patches);
    await submitAttempt(actor, started.attemptId);
    sat++;
  }
  return { sat, percent: answered ? Math.round((100 * correct) / answered) : 0 };
}

/** Put a paper in its week: the window, the sittings and the answers. */
async function backdate(assessmentId: string, assignmentId: string, opens: Date, closes: Date) {
  const published = new Date(opens.getTime() - DAY);
  await db.query(`update assessments set created_at = $2::timestamp, published_at = $2::timestamp where id = $1`, [assessmentId, utc(published)]);
  await db.query(`update assignments set opens_at = $2::timestamp, closes_at = $3::timestamp, created_at = $2::timestamp where id = $1`,
    [assignmentId, utc(opens), utc(closes)]);
  await db.query(
    `update attempts set started_at = $2::timestamp + (random() * interval '2 days') where assignment_id = $1`, [assignmentId, utc(opens)]);
  await db.query(
    `update attempts set submitted_at = started_at + interval '12 minutes' + (random() * interval '15 minutes'),
                         expires_at = started_at + (duration_ms * interval '1 millisecond')
      where assignment_id = $1`, [assignmentId]);
  await db.query(`update attempts set scored_at = submitted_at, created_at = started_at, updated_at = submitted_at where assignment_id = $1`, [assignmentId]);
  await db.query(
    `update attempt_answers aa set answered_at = a.submitted_at - interval '1 minute'
       from attempts a where a.id = aa.attempt_id and a.assignment_id = $1`, [assignmentId]);
}

for (const [chapterNumber, weeksAgo, classAdj] of PAPERS) {
  const qs = (await db.query(
    `select q.id, q.difficulty, q.marks, ch.title
       from questions q join chapters ch on ch.id = q.chapter_id
      where q.organization_id = $1 and q.subject_id = $2 and ch.number = $3
        and q.status = 'APPROVED' and q.deleted_at is null and q.type = 'MCQ'
        and exists (select 1 from question_outcomes qo join concept_outcomes co on co.learning_outcome_id = qo.learning_outcome_id where qo.question_id = q.id)
      order by q.difficulty, q.id`, [ctx.org, ctx.subject, chapterNumber])).rows;
  const pick = (d: string, n: number) => qs.filter((q) => q.difficulty === d).slice(0, n);
  let chosen = [...pick("EASY", 4), ...pick("MEDIUM", 6), ...pick("HARD", 2)];
  if (chosen.length < 12) chosen = [...chosen, ...qs.filter((q) => !chosen.includes(q)).slice(0, 12 - chosen.length)];
  const title = `Mock Test ${PAPERS.findIndex((p) => p[0] === chapterNumber) + 1} · ${qs[0].title}`;
  const totalMarks = chosen.reduce((sum, q) => sum + Number(q.marks), 0);
  const opens = new Date(Date.now() - weeksAgo * 7 * DAY);
  const closes = new Date(opens.getTime() + 3 * DAY);

  // Resumable: a paper already created and sat is only (re)dated.
  const prior = (await db.query(
    `select a.id assessment, s.id assignment from assessments a join assignments s on s.assessment_id = a.id
      where a.organization_id = $1 and a.title = $2 and a.deleted_at is null limit 1`, [ctx.org, title])).rows[0];
  if (prior) {
    // A run that died mid-paper leaves some students unsat while the window is
    // still open (dating happens last). Finish them, then date the paper.
    const open = (await db.query(`select closes_at > (now() at time zone 'utc') open from assignments where id = $1`, [prior.assignment])).rows[0].open;
    if (open) {
      const done = new Set((await db.query(`select student_user_id from attempts where assignment_id = $1`, [prior.assignment])).rows.map((r) => r.student_user_id));
      const missing = students.filter((s) => !done.has(s.id) && !absent.has(`${s.id}:${chapterNumber}`));
      await sitPaper(prior.assessment, prior.assignment, missing, chapterNumber, classAdj);
      console.log(`${title}: finished ${missing.length} unsat students`);
    }
    await backdate(prior.assessment, prior.assignment, opens, closes);
    console.log(`${title}: dated ${utc(opens).slice(0, 10)}`);
    continue;
  }

  const created = await createAssessment(teacher, {
    title, subjectId: ctx.subject, gradeId: ctx.grade, classId: ctx.class, durationMinutes: 30, totalMarks,
  });
  if ("error" in created) throw new Error(`${title}: ${created.error}`);
  const set = await setQuestions(teacher, created.id, chosen.map((q) => q.id));
  if (!set.ok) throw new Error(`${title}: ${set.error}`);
  const published = await publishAssessment(teacher, created.id);
  if (!published.ok) throw new Error(`${title}: ${published.problems.join("; ")}`);

  const assigned = await createAssignment(teacher, {
    assessmentId: created.id, classId: ctx.class,
    opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + DAY),
    maxAttempts: 1, resultsPolicy: "IMMEDIATE",
  });
  if (!assigned.ok) throw new Error(`${title}: ${assigned.message}`);

  const list = students.filter((s) => !absent.has(`${s.id}:${chapterNumber}`));
  const { sat, percent } = await sitPaper(created.id, assigned.id, list, chapterNumber, classAdj);
  const correctTotal = percent, answered = 100;

  await backdate(created.id, assigned.id, opens, closes);

  console.log(`${title}: ${chosen.length} questions, ${sat} sat, ${Math.round((100 * correctTotal) / answered)}% correct, dated ${opens.toISOString().slice(0, 10)}`);
}

// The ledger is dated from the sittings, so it has to be re-derived now that
// the sittings sit in their weeks. rebuildMastery is the sanctioned path.
await db.query(
  `update concept_evidence ce set observed_at = a.submitted_at
     from attempt_answers aa join attempts a on a.id = aa.attempt_id
    where aa.id = ce.attempt_answer_id and a.organization_id = $1`, [ctx.org]);
const rebuilt = await rebuildMastery(ctx.org);
console.log("mastery rebuilt:", JSON.stringify(rebuilt));

const gaps = await detectForClass(ctx.org, ctx.class);
console.log("gaps:", JSON.stringify(gaps));

const reports = await generateForClass(teacher, {
  classId: ctx.class, periodStart: new Date(Date.now() - 7 * 7 * DAY), periodEnd: new Date(),
});
if (!reports.ok) console.log("reports refused:", reports.message);
else {
  const made = reports.rows.filter((r) => r.reportId).length;
  console.log(`reports: ${made} written, ${reports.rows.length - made} refused`);
  for (const r of reports.rows.filter((r) => !r.reportId)) console.log(`  ${r.fullName}: ${r.skipped}`);
}

await db.end();
process.exit(0);
