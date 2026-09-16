/**
 * End-to-end smoke check for learning gaps and joining by code.
 *
 *   npm run build && npm start
 *   node scripts/smoke-gaps.mjs
 *
 * The property this exists to hold: a gap closes on evidence and on nothing
 * else. There is no route that closes one, and the check looks for its absence
 * as much as for the presence of everything else.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-gaps.mjs");
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

// --- A class of three, on a concept-covered outcome ------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Gap Teacher",
  email: `gap.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Gap Centre ${stamp}`,
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
    name: "Class 10-E",
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
check("and it has a join code", Boolean(klass?.joinCode), `${klass?.joinCode}`);

const phones = [0, 1, 2, 3].map((i) => `9${String(stamp + i * 17).slice(-9)}`);
let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: ["First", "Second", "Third"]
    .map((n, i) => `${n} Student, ${phones[i]}`)
    .join("\n"),
});
check("three students are added", r.body?.added === 3, JSON.stringify(r.body));

const questionIds = [];
for (let index = 0; index < 4; index++) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: chapter.subjectId,
    chapterId: chapter.id,
    difficulty: "MEDIUM",
    marks: 1,
    stem: `Gap question ${index + 1} for ${stamp}`,
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
  title: `Gap paper ${stamp}`,
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

// --- Nothing measured, nothing claimed -------------------------------------

r = await teacher.json(`/api/classes/${klass.id}/gaps/`);
check("gaps load before anybody has sat anything", r.status === 200,
  `status ${r.status}`);
check("and there are none", r.body?.gaps?.length === 0, `${r.body?.gaps?.length}`);

// --- All three do badly ----------------------------------------------------

async function sitBadly(phone) {
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
      response: { kind: "choice", keys: ["B"] },
      clientSeq: 1,
    })),
  });
  await api.json(`/api/attempts/${started.body.attemptId}/submit/`, "POST", {
    reason: "MANUAL",
  });
  return true;
}

check("the first student sits it", await sitBadly(phones[0]));

r = await teacher.json(`/api/classes/${klass.id}/gaps/`);
// One student's bad afternoon is not a class gap. Calling it one would have a
// teacher reteaching to a room that was fine.
check("one struggling student is not yet a class gap",
  r.body?.gaps?.length === 0, `${r.body?.gaps?.length}`);

check("the second student sits it", await sitBadly(phones[1]));
check("the third student sits it", await sitBadly(phones[2]));

r = await teacher.json(`/api/classes/${klass.id}/gaps/`);
const gap = r.body?.gaps?.[0];
check("three of three struggling opens a class gap", Boolean(gap),
  `${r.body?.gaps?.length}`);
check("detected without anybody pressing anything", gap?.status === "DETECTED",
  gap?.status);
check("at high severity", gap?.severity === "HIGH", gap?.severity);
check("with the denominator alongside",
  gap?.affectedStudentCount === 3 && gap?.measuredStudentCount === 3,
  JSON.stringify({ affected: gap?.affectedStudentCount, measured: gap?.measuredStudentCount }));
check("and the concept named", Boolean(gap?.conceptName), gap?.conceptName);

// --- Acknowledging is not closing ------------------------------------------

r = await teacher.json(`/api/gaps/${gap.id}/acknowledge/`, "POST");
check("a teacher can say they have seen it", r.status === 200, `status ${r.status}`);

r = await teacher.json(`/api/classes/${klass.id}/gaps/`);
check("and it stays open", r.body?.gaps?.[0]?.status === "ACKNOWLEDGED",
  r.body?.gaps?.[0]?.status);
check("with no resolution date", r.body?.gaps?.[0]?.resolvedAt === null);

// There is deliberately no route that closes a gap. A teacher who could
// dismiss one would be keeping a tidy dashboard rather than teaching.
for (const method of ["DELETE", "PATCH"]) {
  const attempt = await fetch(`${BASE}/api/gaps/${gap.id}/`, { method });
  check(`no ${method} route closes a gap`, attempt.status === 404 || attempt.status === 405,
    `status ${attempt.status}`);
}

// --- Joining with a code ---------------------------------------------------

const newcomer = session();
check("a fourth student signs in", await signInStudentUnrostered(newcomer, phones[3]));

async function signInStudentUnrostered(api, phone) {
  // Rostered by the teacher into no class, so joining is the only way in.
  await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
    text: `Fourth Student, ${phone}`,
  });
  await teacher.json(`/api/classes/${klass.id}/students/`, "GET");
  return signInStudent(api, phone);
}

r = await newcomer.json("/api/student/join/", "POST", { code: "NOTACODE" });
check("a wrong code is refused", r.status === 404, `status ${r.status}`);
check("and says nothing about whether it exists elsewhere",
  r.body?.error?.message === "No class here uses that code.",
  r.body?.error?.message ?? "");

r = await newcomer.json("/api/student/join/", "POST", {
  code: klass.joinCode.toLowerCase(),
});
check("the right code joins the class, whatever the case", r.status === 200,
  `status ${r.status}`);
check("and names the class", r.body?.className === "Class 10-E", r.body?.className);

r = await newcomer.json("/api/student/join/", "POST", { code: klass.joinCode });
check("joining twice is not an error", r.status === 200 && r.body?.alreadyIn === true,
  JSON.stringify({ status: r.status, alreadyIn: r.body?.alreadyIn }));

const other = session();
await other.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `gap2.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});
r = await other.json(`/api/classes/${klass.id}/gaps/`);
check("another organisation sees no gaps here", r.body?.gaps?.length === 0,
  `${r.body?.gaps?.length}`);

r = await newcomer.json(`/api/classes/${klass.id}/gaps/`);
check("a student cannot read the class gap list", r.status === 403,
  `status ${r.status}`);

// --- The pages -------------------------------------------------------------

r = await teacher.page(`/teacher/analytics/${klass.id}/gaps/`);
check("the gaps page renders", r.status === 200, `status ${r.status}`);
check("and says how a gap closes", r.html.includes("evidence closes it"), "");

r = await teacher.page(`/teacher/analytics/${klass.id}/`);
check("the class page links to it", r.html.includes("Learning gaps"));

r = await newcomer.page("/student/");
check("the student home offers joining by code",
  r.html.includes("Join a class with a code"));

await db.end();
report();
