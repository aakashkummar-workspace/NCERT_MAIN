import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-benchmarks.mjs");
/**
 * End-to-end smoke check for cross-school concept benchmarks.
 *
 *   npm run build && npm start
 *   node scripts/smoke-benchmarks.mjs
 *
 * What needs a real HTTP round trip:
 *
 *   1. **Below the school floor, the page says nothing.** Not a dash, not an
 *      empty panel — the row simply carries no comparison.
 *   2. **At the floor it says a sentence, and the sentence names no school.**
 *      The rendered HTML is grepped for every contributing school's id, name
 *      and slug, and for the words a league table would need.
 *   3. **Opting in and out is an owner's decision**, and withdrawing deletes
 *      what was published rather than freezing it.
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const BASE = process.env.BASE ?? "http://localhost:3210";

try {
  const probe = await fetch(`${BASE}/signin/`);
  if (probe.status !== 200) throw new Error(`status ${probe.status}`);
} catch (error) {
  console.error(`No server at ${BASE} — run: npm run build && npm start\n${error}`);
  process.exit(1);
}

const results = [];
const check = (name, pass, detail = "") => results.push({ name, pass, detail });

function report(reason) {
  let failed = 0;
  for (const { name, pass, detail } of results) {
    if (!pass) failed++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  }
  console.log(`${results.length - failed}/${results.length} checks passed`);
  if (reason) console.error(`Stopped early: ${reason}`);
  process.exit(failed === 0 && !reason ? 0 : 1);
}

process.on("unhandledRejection", (error) => report(String(error)));
process.on("uncaughtException", (error) => report(String(error)));

const stamp = Date.now();

function session() {
  let cookie = "";
  return {
    async json(path, method = "GET", body) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async page(path) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      return { status: res.status, html: await res.text() };
    },
  };
}

// Local only — `assertLocalDatabase` above refuses anything else, which is
// also why this needs no TLS options.
const db = new pg.Client({ connectionString: process.env.DIRECT_URL });
await db.connect();

// --- A school with a measured class ---------------------------------------

const teacher = session();
const signup = await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Benchmark Teacher",
  email: `bmk.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Benchmark Centre ${stamp}`,
  organizationType: "TUITION_CENTRE",
  boardCode: "CBSE",
});
check("a school is created", signup.status === 200, `status ${signup.status}`);

// A concept that is actually mapped to an outcome, so the class read knows
// about it — the benchmark is keyed by concept, as every mastery figure is.
const covered = await db.query(
  `select co.concept_id, co.learning_outcome_id as outcome_id
     from concept_outcomes co limit 1`,
);
const conceptId = covered.rows[0]?.concept_id;
check("a concept covering an outcome exists", Boolean(conceptId));

// This script has to use a REAL concept — the page shows a benchmark beside a
// concept the class is measured on — so it clears whatever earlier runs
// published on it first, and clears up again at the end. Counting "5 schools"
// against a table that still holds the last run's five would fail on the
// second run and pass again on the eleventh, which is the worst kind of test.
await db.query("delete from concept_benchmarks where concept_id = $1", [conceptId]);

const picker = await teacher.json("/api/curriculum/picker/");
const outcome = picker.body.outcomes.find((o) => o.id === covered.rows[0].outcome_id);
const chapter = picker.body.chapters.find((c) => c.id === outcome?.chapterId);

const classesPage = await teacher.page("/teacher/classes/new/");
const gradeIds = [
  ...new Set(
    [
      ...(classesPage.html.split('id="subjectId"')[0] ?? "").matchAll(
        /value="([0-9a-f-]{36})"/g,
      ),
    ].map((m) => m[1]),
  ),
];

let klass = null;
let gradeId = null;
for (const candidate of gradeIds) {
  const attempt = await teacher.json("/api/classes/", "POST", {
    name: "Class 10-B",
    gradeId: candidate,
    subjectId: chapter.subjectId,
    academicYear: "2026-27",
  });
  if (attempt.status === 200) {
    klass = attempt.body;
    gradeId = candidate;
    break;
  }
}
check("a class is created", Boolean(klass?.id));

const phone = `96${String(stamp).slice(-8)}`;
await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: `Benchmark Student, ${phone}`,
});

// A concept row only appears on the analytics page once somebody in the class
// has been measured on it — the benchmark sits BESIDE a figure, not on its
// own. So one student sits one paper: enough for the concept to exist here,
// and deliberately not enough for a class mean, which is the state the
// comparison has to handle without inventing one.
const question = await teacher.json("/api/questions/", "POST", {
  type: "MCQ",
  subjectId: chapter.subjectId,
  chapterId: chapter.id,
  difficulty: "MEDIUM",
  marks: 1,
  stem: `A benchmark question ${stamp}`,
  options: [
    { key: "A", text: "The right one", isCorrect: true },
    { key: "B", text: "The wrong one", isCorrect: false },
  ],
  explanation: "Because the definition says so.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${question.body.id}/`, "POST", { action: "approve" });

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Benchmark paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 30,
  totalMarks: 1,
});
await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
  questionIds: [question.body.id],
});
await teacher.json(`/api/assessments/${assessment.body.id}/publish/`, "POST");

const assigned = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  opensAt: new Date(Date.now() - 60_000).toISOString(),
  closesAt: new Date(Date.now() + 86_400_000).toISOString(),
  maxAttempts: 1,
  resultsPolicy: "IMMEDIATE",
});
check("a paper is assigned", assigned.status === 200, `status ${assigned.status}`);

const student = session();
await db.query("delete from login_codes where phone = $1", [phone]);
const requested = await student.json("/api/auth/otp/request/", "POST", { phone });
let code = requested.body?.devCode;
if (!code) {
  code = "246813";
  await db.query("select app_auth_issue_code($1, $2, $3)", [
    phone,
    createHash("sha256").update(`${phone}:${code}`, "utf8").digest(),
    new Date(Date.now() + 5 * 60_000),
  ]);
}
const verified = await student.json("/api/auth/otp/verify/", "POST", { phone, code });
check("the student signs in", verified.status === 200, `status ${verified.status}`);

const started = await student.json("/api/attempts/", "POST", {
  assignmentId: assigned.body.id,
  clientAttemptId: randomUUID(),
});
const player = await student.json(`/api/attempts/${started.body.attemptId}/`);
await student.json(`/api/attempts/${started.body.attemptId}/answers/`, "PATCH", {
  answers: player.body.questions.map((q) => ({
    assessmentQuestionId: q.assessmentQuestionId,
    response: { kind: "choice", keys: ["B"] },
    clientSeq: 1,
  })),
});
await student.json(`/api/attempts/${started.body.attemptId}/submit/`, "POST", {
  reason: "MANUAL",
});

// --- Below the floor, the page says nothing --------------------------------

let page = await teacher.page(`/teacher/analytics/${klass.id}/`);
check("the class analytics page renders", page.status === 200, `status ${page.status}`);
// Nothing has been published on this concept yet, so there is no comparison —
// and no empty panel and no dash either.
check("with no benchmark while too few schools contribute",
  !/Across \d+ schools/.test(page.html), "");

// --- Five schools publish one figure each ---------------------------------
//
// Real signups, then one contribution row each written directly: the nightly
// job is what normally writes these, and what is under test here is the PAGE.

const schools = [];
for (const [index, mean] of [0.42, 0.55, 0.61, 0.7, 0.86].entries()) {
  const other = session();
  const created = await other.json("/api/auth/signup/", "POST", {
    fullName: `Peer Teacher ${index}`,
    email: `bmk.peer.${index}.${stamp}@example.test`,
    password: "a-long-enough-password",
    organizationName: `Peer School ${index} ${stamp}`,
    organizationType: "SCHOOL",
    boardCode: "CBSE",
  });
  const row = await db.query(
    `select id, name, slug from organizations where slug = $1 or name = $2 limit 1`,
    [created.body?.organizationSlug ?? "", `Peer School ${index} ${stamp}`],
  );
  const organization = row.rows[0];
  schools.push(organization);
  await db.query(
    `insert into concept_benchmarks
       (id, organization_id, concept_id, measured_students, mean_estimate)
     values (gen_random_uuid(), $1, $2, $3, $4)`,
    [organization.id, conceptId, 8, mean],
  );
}
check("five schools publish a figure each", schools.length === 5);

page = await teacher.page(`/teacher/analytics/${klass.id}/`);
check("now the page carries a benchmark", /Across 5 schools/.test(page.html), "");
// The middle school, and a spread. Never a position.
check("naming the middle school's figure and the spread",
  /middle school sits at 61%/.test(page.html) &&
    /most between 55% and 70%/.test(page.html),
  "");
// This class has nothing measured yet (one student, no sittings), so the
// comparison says so rather than inventing a class figure.
check("and saying there is not enough measured here to compare",
  /not enough measured here yet/.test(page.html), "");

// --- No school is identifiable, ever --------------------------------------

let leaked = [];
for (const organization of schools) {
  if (page.html.includes(organization.id)) leaked.push(`${organization.name} id`);
  if (page.html.includes(organization.slug)) leaked.push(`${organization.name} slug`);
  if (page.html.includes(organization.name)) leaked.push(organization.name);
}
check("no contributing school is named on the page", leaked.length === 0,
  leaked.join(", "));
// A rank is a league table with better manners, and "3rd of 5" identifies two
// schools by elimination the moment anybody compares notes.
for (const word of ["league", "percentile", "1st of", "2nd of", "3rd of"]) {
  check(`and the page never says "${word}"`,
    !new RegExp(word, "i").test(page.html), "");
}

// --- One school short, and it refuses again -------------------------------

await db.query(`delete from concept_benchmarks where organization_id = $1`, [
  schools[0].id,
]);
page = await teacher.page(`/teacher/analytics/${klass.id}/`);
// Four schools is not a median across schools, it is four schools — and with
// four, each of them can narrow down the others.
check("one school short, the figure disappears again",
  !/Across \d+ schools/.test(page.html), "");

// --- Opting in is an owner's decision -------------------------------------

let r = await teacher.json("/api/institute/benchmarks/", "PUT", { contributing: true });
check("an owner can agree to contribute", r.status === 200, `status ${r.status}`);

page = await teacher.page("/teacher/settings/");
check("settings says the school is contributing",
  /Contributing/.test(page.html), "");
// Said before they press, on the card itself.
check("and that contributing is not the price of reading",
  /not the price of reading/i.test(page.html), "");

r = await teacher.json("/api/institute/benchmarks/", "PUT", { contributing: false });
check("and can withdraw again", r.status === 200, `status ${r.status}`);
check("which reports what was deleted rather than frozen",
  typeof r.body?.removed === "number", JSON.stringify(r.body));

r = await teacher.json("/api/institute/benchmarks/", "PUT", { contributing: "yes" });
check("a malformed body is refused", r.status === 400, `status ${r.status}`);

// --- Scope ----------------------------------------------------------------

r = await fetch(`${BASE}/api/institute/benchmarks/`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ contributing: true }),
});
check("an anonymous caller cannot change it", r.status === 401, `status ${r.status}`);

r = await student.json("/api/institute/benchmarks/", "PUT", { contributing: true });
// A student does not hold `organization:update` — the same refusal every other
// write about the school makes.
check("a student cannot change it", r.status === 403, `status ${r.status}`);

// --- The scheduled job ----------------------------------------------------

r = await fetch(`${BASE}/api/cron/refresh-benchmarks/`, { method: "POST" });
check("the job refuses an unauthenticated caller",
  r.status === 404 || r.status === 500, `status ${r.status}`);

if (process.env.CRON_SECRET) {
  r = await fetch(`${BASE}/api/cron/refresh-benchmarks/`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const ran = await r.json().catch(() => null);
  check("the scheduler can recompute contributions", r.status === 200,
    `status ${r.status}`);
  check("and reports what it did", typeof ran?.organizations === "number",
    JSON.stringify(ran));
}

// Taken away again: contribution rows for a real concept would otherwise make
// this database claim that five schools are measuring it, which the next run —
// and anybody reading the aggregate by hand — would believe.
await db.query("delete from concept_benchmarks where concept_id = $1", [conceptId]);

await db.end();
report();
