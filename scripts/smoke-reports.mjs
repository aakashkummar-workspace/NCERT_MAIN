/**
 * End-to-end smoke check for term reports.
 *
 *   npm run build && npm start
 *   node scripts/smoke-reports.mjs
 *
 * Six properties that need a real HTTP round trip to prove:
 *
 *   1. **The plan is asked before the data.** A teacher on the free shape hears
 *      about their plan, not about their evidence.
 *   2. **A thin report is refused, and the student is NAMED.** A teacher who
 *      gets 26 of 30 must know which four.
 *   3. **The payload is stamped.** Moving the mastery underneath a written
 *      report must not change a word of it.
 *   4. **There is no overall grade on the sheet**, and there is no route that
 *      edits or deletes one — the check looks for the absence.
 *   5. **A parent reads it through their own door**, and a report id is not a
 *      capability: an unlinked parent gets nothing.
 *   6. **The nav no longer says "soon"**, which is the promise this closes.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-reports.mjs");
import { createHash } from "node:crypto";
import pg from "pg";
import {
  databaseNow,
  fixtureChapterNumber,
  removeFixtureCurriculum,
} from "./lib/fixture-curriculum.mjs";

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
const hours = (n) => n * 3600_000;
const STUDENT_NAME = "Anjali Reportwala";

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

const db = new pg.Client({ connectionString: process.env.DIRECT_URL });
await db.connect();
const since = await databaseNow(db);

async function signInStudent(api, phone) {
  await db.query("delete from login_codes where phone = $1", [phone]);
  const requested = await api.json("/api/auth/otp/request/", "POST", { phone });
  let code = requested.body?.devCode;
  if (!code) {
    code = "246813";
    await db.query("select app_auth_issue_code($1, $2, $3)", [
      phone,
      createHash("sha256").update(`${phone}:${code}`, "utf8").digest(),
      new Date(Date.now() + 5 * 60_000),
    ]);
  }
  const verified = await api.json("/api/auth/otp/verify/", "POST", { phone, code });
  return verified.status === 200;
}

// --- A class, three concepts, one measured student ---------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Report Teacher",
  email: `rep.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Report Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const org = await db.query("select id from organizations where name = $1", [
  `Report Centre ${stamp}`,
]);
const organizationId = org.rows[0]?.id;
check("the organisation exists", Boolean(organizationId));

const picker = await teacher.json("/api/curriculum/picker/");
const anyOutcome = picker.body.outcomes[0];
const chapter = picker.body.chapters.find((c) => c.id === anyOutcome?.chapterId);
check("a chapter exists to author against", Boolean(chapter));

// Three concepts, authored on the platform connection — the seeded curriculum
// holds two in total, which is a designed state (concepts are written by
// somebody who teaches the subject) and also means no real school could be
// handed a report today. The refusal is right; the curriculum is what is thin.
// Into a fixture chapter of the same subject, never a real one: the questions
// below must share a subject with the class, and anything authored into a
// seeded chapter becomes part of every school's syllabus.
const fixture = await db.query(
  `insert into chapters (id, subject_id, number, title, source)
   values (gen_random_uuid(), $1, $2, 'Smoke reports fixture', 'smoke-reports.mjs — removed at the end of the run')
   returning id`,
  [chapter.subjectId, fixtureChapterNumber()],
);
const fixtureChapterId = fixture.rows[0].id;
const topic = await db.query(
  `insert into topics (id, chapter_id, title, sort_order)
   values (gen_random_uuid(), $1, 'Smoke reports topic', 0) returning id`,
  [fixtureChapterId],
);
const outcomeIds = [];
for (const index of [1, 2, 3]) {
  const outcome = await db.query(
    `insert into learning_outcomes (id, topic_id, code, statement, bloom_level, sort_order, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, 'APPLY', $4, now(), now()) returning id`,
    [
      topic.rows[0].id,
      `SMK-${stamp}-${index}`,
      `Apply the ${index}th smoke idea to a worked problem.`,
      index,
    ],
  );
  const concept = await db.query(
    `insert into concepts (id, slug, name, created_at)
     values (gen_random_uuid(), $1, $2, now()) returning id`,
    [`smoke-concept-${stamp}-${index}`, `Smoke concept ${index}`],
  );
  await db.query(
    `insert into concept_outcomes (concept_id, learning_outcome_id, weight)
     values ($1, $2, 1)`,
    [concept.rows[0].id, outcome.rows[0].id],
  );
  outcomeIds.push(outcome.rows[0].id);
}
check("three concepts are authored", outcomeIds.length === 3);

const newClassPage = await teacher.page("/teacher/classes/new/");
const gradeIds = [
  ...new Set(
    [
      ...(newClassPage.html.split('id="subjectId"')[0] ?? "").matchAll(
        /value="([0-9a-f-]{36})"/g,
      ),
    ].map((m) => m[1]),
  ),
];

let klass = null;
let gradeId = null;
for (const candidate of gradeIds) {
  const attempt = await teacher.json("/api/classes/", "POST", {
    name: "Class 10-R",
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

const phone = `9${String(stamp).slice(-9)}`;
let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: `${STUDENT_NAME}, ${phone}\nQuiet Student, ${`8${String(stamp).slice(-9)}`}`,
});
check("two students are added", r.body?.added === 2, JSON.stringify(r.body));

const questionIds = [];
for (const [index, outcomeId] of outcomeIds.entries()) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: chapter.subjectId,
    chapterId: fixtureChapterId,
    difficulty: "MEDIUM",
    marks: 1,
    stem: `Smoke report question ${index} for ${stamp} — which one applies?`,
    options: [
      { key: "A", text: "The right one", isCorrect: true },
      { key: "B", text: "A wrong one", isCorrect: false },
      { key: "C", text: "Another wrong one", isCorrect: false },
    ],
    explanation: "Because the definition says so.",
    outcomeIds: [outcomeId],
  });
  await teacher.json(`/api/questions/${created.body.id}/`, "POST", {
    action: "approve",
  });
  questionIds.push(created.body.id);
}

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Report paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 30,
  totalMarks: questionIds.length,
});
await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
  questionIds,
});
await teacher.json(`/api/assessments/${assessment.body.id}/publish/`, "POST");
r = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  opensAt: new Date(Date.now() - 60_000).toISOString(),
  closesAt: new Date(Date.now() + hours(24)).toISOString(),
  maxAttempts: 5,
  resultsPolicy: "IMMEDIATE",
});
const assignmentId = r.body?.id;

const student = session();
check("the student signs in", await signInStudent(student, phone));

for (let pass = 0; pass < 4; pass++) {
  const started = await student.json("/api/attempts/", "POST", {
    assignmentId,
    clientAttemptId: crypto.randomUUID(),
  });
  const player = await student.json(`/api/attempts/${started.body.attemptId}/`);
  await student.json(`/api/attempts/${started.body.attemptId}/answers/`, "PATCH", {
    answers: player.body.questions.map((question, index) => ({
      assessmentQuestionId: question.assessmentQuestionId,
      response: { kind: "choice", keys: ["B"] },
      clientSeq: index + 1,
    })),
  });
  await student.json(`/api/attempts/${started.body.attemptId}/submit/`, "POST", {
    reason: "MANUAL",
  });
}

const period = {
  periodStart: new Date(Date.now() - hours(24 * 200)).toISOString(),
  periodEnd: new Date().toISOString(),
};

// --- 1. The plan, before the data --------------------------------------------

r = await teacher.json("/api/reports/", "POST", { classId: klass.id, ...period });
check("without reports on the plan, it is refused", r.status === 409,
  `status ${r.status}`);
check("and says so in terms of the plan, not of evidence",
  /plan/i.test(r.body?.error?.message ?? ""), r.body?.error?.message ?? "");

const plan = await db.query("select id from plans where code = 'teacher_pro'");
await db.query(
  `insert into subscriptions
     (id, organization_id, plan_id, status, current_period_start, created_at, updated_at)
   values (gen_random_uuid(), $1, $2, 'ACTIVE', now(), now(), now())`,
  [organizationId, plan.rows[0].id],
);

// --- 2. Written for one, refused for the other, and named ---------------------

r = await teacher.json("/api/reports/", "POST", { classId: klass.id, ...period });
check("with the plan allowing it, the class runs", r.status === 201,
  `status ${r.status}`);

const rows = r.body?.rows ?? [];
const written = rows.filter((row) => row.reportId !== null);
const skipped = rows.filter((row) => row.reportId === null);
check("one report is written", written.length === 1, `${written.length}`);
check("and the student who sat nothing is skipped", skipped.length === 1,
  `${skipped.length}`);
check("named, not just counted",
  skipped[0]?.fullName === "Quiet Student", skipped[0]?.fullName ?? "");
check("with the reason on the row",
  /measured|test/i.test(skipped[0]?.skipped ?? ""), skipped[0]?.skipped ?? "");

const reportId = written[0]?.reportId;

// --- 3. Stamped ---------------------------------------------------------------

const before = await db.query("select payload::text as p from reports where id = $1", [
  reportId,
]);
await db.query(
  `update student_concept_mastery set estimate = 0.99, band = 'SECURE'
    where organization_id = $1`,
  [organizationId],
);
const after = await db.query("select payload::text as p from reports where id = $1", [
  reportId,
]);
// The same invariant as an intervention's baseline. A parent shown a figure in
// September must be able to bring that sheet in December.
check("moving the mastery does not change a written report",
  before.rows[0].p === after.rows[0].p, "");

const sheet = await teacher.page(`/teacher/reports/${reportId}/`);
check("the report page renders", sheet.status === 200, `status ${sheet.status}`);
check("with the student's name on it", sheet.html.includes(STUDENT_NAME), "");
check("and the coverage denominator above the marks",
  /ideas measured/.test(sheet.html), "");
check("and the standing caveat",
  /there is no overall grade/i.test(sheet.html), "");

// --- 4. No overall grade, and no route that edits one -------------------------

check("the sheet carries no overall percentage",
  !/overall/i.test(sheet.html.replace(/no overall grade/gi, "")), "");

for (const method of ["PATCH", "PUT", "DELETE"]) {
  const res = await fetch(`${BASE}/api/reports/`, { method });
  check(`no ${method} on /api/reports/ exists`,
    res.status === 404 || res.status === 405, `status ${res.status}`);
}

// Regenerating supersedes rather than overwriting.
r = await teacher.json("/api/reports/", "POST", {
  studentUserId: written[0].studentUserId,
  ...period,
});
check("regenerating writes a new report", r.status === 201, `status ${r.status}`);
const kept = await db.query(
  "select count(*)::int as n from reports where organization_id = $1",
  [organizationId],
);
check("and keeps the old one", kept.rows[0].n === 2, `${kept.rows[0].n}`);

const list = await teacher.page("/teacher/reports/");
check("the list marks the older one superseded",
  /superseded/i.test(list.html), "");

// --- 5. The parent's own door --------------------------------------------------

// Consent is what unlocks a report, never a role. Granted directly here: the
// invitation flow has its own suite, and what this one is checking is that the
// READ path honours the link.
await db.query(
  `insert into users (id, full_name, phone, created_at, updated_at)
   values (gen_random_uuid(), 'Direct Parent', $1, now(), now())
   on conflict (phone) do nothing`,
  [`6${String(stamp).slice(-9)}`],
);
const parentUser = await db.query("select id from users where phone = $1", [
  `6${String(stamp).slice(-9)}`,
]);
await db.query(
  `insert into memberships (id, organization_id, user_id, role, status, created_at, updated_at)
   values (gen_random_uuid(), $1, $2, 'PARENT', 'ACTIVE', now(), now())`,
  [organizationId, parentUser.rows[0].id],
);
await db.query(
  `insert into parent_student_links
     (id, organization_id, parent_user_id, student_user_id, relationship,
      consent_granted_at, scope, created_at, updated_at)
   values (gen_random_uuid(), $1, $2, $3, 'GUARDIAN', now(), '{"performance": true}', now(), now())`,
  [organizationId, parentUser.rows[0].id, written[0].studentUserId],
);

const parent = session();
check("the parent signs in", await signInStudent(parent, `6${String(stamp).slice(-9)}`));

const parentList = await parent.page("/parent/reports/");
check("the parent sees their child's reports", parentList.status === 200,
  `status ${parentList.status}`);
check("with a link to the sheet", parentList.html.includes(`/parent/reports/${reportId}`),
  "");

const parentSheet = await parent.page(`/parent/reports/${reportId}/`);
check("and can open it", parentSheet.status === 200, `status ${parentSheet.status}`);
check("seeing the same document", parentSheet.html.includes(STUDENT_NAME), "");
// The one that matters: an older sheet stays readable AND says it is old.
check("told plainly that a newer one exists",
  /newer report has been written/i.test(parentSheet.html), "");

// A report id is not a capability.
const stranger = session();
await stranger.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `rep.other.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Report ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});
const strangerSheet = await stranger.page(`/teacher/reports/${reportId}/`);
check("another organisation cannot open the sheet",
  strangerSheet.status === 404 || !strangerSheet.html.includes(STUDENT_NAME),
  `status ${strangerSheet.status}`);

r = await student.json(`/api/reports/?studentUserId=${written[0].studentUserId}`);
check("a student cannot list reports through the staff route",
  r.status === 403 || r.status === 401 || r.status === 404, `status ${r.status}`);

// --- 6. The nav no longer says "soon" -------------------------------------------

const dashboard = await teacher.page("/teacher");
check("Reports is a real link in the navigation",
  dashboard.html.includes('href="/teacher/reports/"') ||
    dashboard.html.includes('href="/teacher/reports"'),
  "");
// The promise this slice closes.
check("and is no longer marked soon",
  !/\/teacher\/reports[^<]*<[^>]*>\s*soon/i.test(dashboard.html), "");

// The curriculum plane has no tenant: what this script authored is removed
// here or it stays in every school's syllabus for good.
await removeFixtureCurriculum(db, since);
await db.end();
report();
