/**
 * End-to-end smoke check for teacher analytics.
 *
 *   npm run build && npm start
 *   node scripts/smoke-analytics.mjs
 *
 * The property this exists to hold: the refusal survives aggregation. A class
 * figure averaged over the two students who happen to be measured is
 * arithmetically correct and a false claim, and no page may print one.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-analytics.mjs");
import { createHash } from "node:crypto";
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
const hours = (n) => n * 3600_000;

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

// --- A class of three, on an outcome a concept covers ----------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Analytics Teacher",
  email: `anl.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Analytics Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const covered = await db.query(
  `select co.learning_outcome_id as id from concept_outcomes co limit 1`,
);
const outcomeId = covered.rows[0]?.id;

const picker = await teacher.json("/api/curriculum/picker/");
const outcome = picker.body.outcomes.find((o) => o.id === outcomeId);
const chapter = picker.body.chapters.find((c) => c.id === outcome?.chapterId);
check("an outcome covered by a concept exists", Boolean(outcome && chapter));

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
    name: "Class 10-D",
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

const phones = [0, 1, 2].map((i) => `9${String(stamp + i * 11).slice(-9)}`);
const names = ["First Student", "Second Student", "Third Student"];
let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: names.map((n, i) => `${n}, ${phones[i]}`).join("\n"),
});
check("three students are added", r.body?.added === 3, JSON.stringify(r.body));
const studentIds = r.body.outcomes.map((o) => o.userId);

const questionIds = [];
for (let index = 0; index < 4; index++) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: chapter.subjectId,
    chapterId: chapter.id,
    difficulty: "MEDIUM",
    marks: 1,
    stem: `Analytics question ${index + 1} for ${stamp}`,
    options: [
      { key: "A", text: "The right one", isCorrect: true },
      { key: "B", text: "The wrong one", isCorrect: false },
    ],
    explanation: "Because that is what the definition says.",
    outcomeIds: [outcome.id],
  });
  await teacher.json(`/api/questions/${created.body.id}/`, "POST", { action: "approve" });
  questionIds.push(created.body.id);
}

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Analytics paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 45,
  totalMarks: 4,
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
  maxAttempts: 1,
  resultsPolicy: "IMMEDIATE",
});
const assignmentId = r.body?.id;
check("the paper is assigned", r.status === 200, `status ${r.status}`);

// --- Nothing measured -------------------------------------------------------

r = await teacher.json(`/api/classes/${klass.id}/analytics/`);
check("analytics loads before anybody has sat it", r.status === 200,
  `status ${r.status}`);
check("with all three students counted", r.body?.students === 3,
  `${r.body?.students}`);
check("and nothing measured", r.body?.concepts?.length === 0,
  `${r.body?.concepts?.length}`);
check("saying so, rather than showing zeroes",
  r.body?.unmeasuredStudents === 3, `${r.body?.unmeasuredStudents}`);

// --- Two students sit it ----------------------------------------------------

async function sitPaper(phone, correct) {
  const api = session();
  if (!(await signInStudent(api, phone))) return false;
  const started = await api.json("/api/attempts/", "POST", {
    assignmentId,
    clientAttemptId: crypto.randomUUID(),
  });
  const player = await api.json(`/api/attempts/${started.body.attemptId}/`);
  await api.json(`/api/attempts/${started.body.attemptId}/answers/`, "PATCH", {
    answers: player.body.questions.map((q) => ({
      assessmentQuestionId: q.assessmentQuestionId,
      response: { kind: "choice", keys: [correct ? "A" : "B"] },
      clientSeq: 1,
    })),
  });
  await api.json(`/api/attempts/${started.body.attemptId}/submit/`, "POST", {
    reason: "MANUAL",
  });
  return true;
}

check("the first student sits it", await sitPaper(phones[0], true));
check("the second student sits it", await sitPaper(phones[1], false));

r = await teacher.json(`/api/classes/${klass.id}/analytics/`);
const concept = r.body?.concepts?.[0];
check("the concept now appears", Boolean(concept));
check("with two of three measured", concept?.measured === 2, `${concept?.measured}`);
// Two students is below the threshold. Averaging them and calling it the class
// is arithmetically correct and a false claim.
check("but no class figure is claimed from two students",
  concept?.meanEstimate === null && concept?.band === null,
  JSON.stringify({ mean: concept?.meanEstimate, band: concept?.band }));
check("and nothing is flagged for a lesson on that basis",
  concept?.needsAttention === false);
check("the unmeasured student still has a row",
  r.body?.rows?.length === 3, `${r.body?.rows?.length}`);
check("with a cell for every concept",
  r.body?.rows?.every((row) => row.cells.length === r.body.concepts.length));

// --- The third makes it a class --------------------------------------------

check("the third student sits it", await sitPaper(phones[2], false));

r = await teacher.json(`/api/classes/${klass.id}/analytics/`);
const full = r.body?.concepts?.[0];
check("three measured students produce a class figure",
  typeof full?.meanEstimate === "number", `${full?.meanEstimate}`);
check("with a band to go with it", Boolean(full?.band), `${full?.band}`);
check("two of three struggling flags it for a lesson",
  full?.needsAttention === true && full?.struggling === 2,
  JSON.stringify({ attention: full?.needsAttention, struggling: full?.struggling }));
check("every student is in exactly one band",
  Object.values(full?.counts ?? {}).reduce((a, b) => a + b, 0) === 3,
  JSON.stringify(full?.counts));

// --- One student ------------------------------------------------------------

r = await teacher.json(`/api/students/${studentIds[0]}/mastery/`);
check("a teacher can read one student", r.status === 200, `status ${r.status}`);
check("with their sittings beside the estimate",
  r.body?.sittings?.length === 1 && r.body?.mastery?.length === 1,
  JSON.stringify({ sittings: r.body?.sittings?.length, mastery: r.body?.mastery?.length }));
check("and a real number, because four answers is enough",
  typeof r.body?.mastery?.[0]?.estimate === "number",
  `${r.body?.mastery?.[0]?.estimate}`);

// --- The pages render -------------------------------------------------------

r = await teacher.page("/teacher/analytics/");
check("the analytics index renders", r.status === 200, `status ${r.status}`);
check("and lists the class", r.html.includes("Class 10-D"));

r = await teacher.page(`/teacher/analytics/${klass.id}/`);
check("the class analytics page renders", r.status === 200, `status ${r.status}`);
check("with the heatmap legend", r.html.includes("Not enough evidence yet"));
check("and the concept named", r.html.includes("Student by concept"));

r = await teacher.page(`/teacher/students/${studentIds[0]}/`);
check("the student page renders", r.status === 200, `status ${r.status}`);
check("and shows the papers they sat", r.html.includes("Papers sat"));

// --- Another organisation ---------------------------------------------------

const other = session();
await other.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `anl2.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});

r = await other.json(`/api/classes/${klass.id}/analytics/`);
check("another organisation cannot read this class", r.status === 404,
  `status ${r.status}`);

r = await other.json(`/api/students/${studentIds[0]}/mastery/`);
check("nor this student", r.status === 404, `status ${r.status}`);

// A student is a real user in the other organisation's database too, because
// `users` is global. Being able to name somebody is not the same as them being
// your student, and the guard is a membership check for exactly that reason.
const studentApi = session();
await signInStudent(studentApi, phones[0]);
r = await studentApi.json(`/api/classes/${klass.id}/analytics/`);
check("a student cannot read their own class analytics", r.status === 403,
  `status ${r.status}`);

await db.end();
report();
