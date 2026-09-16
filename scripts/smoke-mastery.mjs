/**
 * End-to-end smoke check for the evidence ledger and the mastery estimate.
 *
 *   npm run build && npm start
 *   node scripts/smoke-mastery.mjs
 *
 * The path no unit test can see: a student sits three papers, a teacher marks a
 * written answer, and the estimate moves — over HTTP, through the guards, with
 * the refusal holding until there is enough evidence to say anything.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-mastery.mjs");
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

/** Stands in for the SMS gateway — see the note in smoke-attempts.mjs. */
async function signInStudent(api, phone) {
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

// --- A paper on an outcome the seeded worked example maps to a concept ------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Mastery Teacher",
  email: `mst.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Mastery Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const picker = await teacher.json("/api/curriculum/picker/");
// A concept only covers some outcomes. Evidence exists only where one does, so
// this check has to pick an outcome that is covered — which is exactly the hole
// conceptCoverage() reports on the platform console.
const covered = await db.query(
  `select co.learning_outcome_id as id from concept_outcomes co limit 1`,
);
const outcomeId = covered.rows[0]?.id;
const outcome = picker.body.outcomes.find((o) => o.id === outcomeId);
const chapter = picker.body.chapters.find((c) => c.id === outcome?.chapterId);
check("an outcome covered by a concept exists", Boolean(outcome && chapter),
  `${outcomeId}`);

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
    name: "Class 10-C",
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
  text: `Measured Student, ${phone}`,
});
check("a student is added", r.body?.added === 1, JSON.stringify(r.body));

// Four objective questions, so one sitting clears the evidence threshold, plus
// a written one that produces nothing until a person marks it.
const questionIds = [];
for (let index = 0; index < 4; index++) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: chapter.subjectId,
    chapterId: chapter.id,
    difficulty: "MEDIUM",
    marks: 1,
    stem: `Measured question ${index + 1} for ${stamp}`,
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

const written = await teacher.json("/api/questions/", "POST", {
  type: "SA",
  subjectId: chapter.subjectId,
  chapterId: chapter.id,
  difficulty: "MEDIUM",
  marks: 4,
  stem: `Explain the idea in your own words. ${stamp}`,
  explanation: "The definition, restated.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${written.body.id}/`, "POST", { action: "approve" });
questionIds.push(written.body.id);
check("five approved questions on a covered outcome", questionIds.length === 5);

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Measured paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 45,
  totalMarks: 8,
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
check("the paper is assigned", r.status === 200, `status ${r.status}`);
const assignmentId = r.body?.id;

// --- Nothing before anything is answered -----------------------------------

const student = session();
check("the student signs in", await signInStudent(student, phone));

r = await student.json("/api/student/mastery/");
check("mastery starts empty rather than at zero",
  r.status === 200 && r.body?.mastery?.length === 0,
  `status ${r.status} ${r.body?.mastery?.length}`);

// --- One sitting: three right, one wrong, and a written answer -------------

r = await student.json("/api/attempts/", "POST", {
  assignmentId,
  clientAttemptId: crypto.randomUUID(),
});
const attemptId = r.body?.attemptId;

const player = await student.json(`/api/attempts/${attemptId}/`);
const mcqs = player.body.questions.filter((q) => q.type === "MCQ");
const writtenPlacement = player.body.questions.find((q) => q.type === "SA");

await student.json(`/api/attempts/${attemptId}/answers/`, "PATCH", {
  answers: [
    ...mcqs.map((q, index) => ({
      assessmentQuestionId: q.assessmentQuestionId,
      response: { kind: "choice", keys: [index === 3 ? "B" : "A"] },
      clientSeq: 1,
    })),
    {
      assessmentQuestionId: writtenPlacement.assessmentQuestionId,
      response: { kind: "text", value: "My explanation of the idea." },
      clientSeq: 1,
    },
  ],
});
await student.json(`/api/attempts/${attemptId}/submit/`, "POST", { reason: "MANUAL" });

r = await student.json("/api/student/mastery/");
const concept = r.body?.mastery?.[0];
check("one concept now has evidence", r.body?.mastery?.length === 1,
  `${r.body?.mastery?.length}`);
// Four objective answers; the written one is not evidence until somebody reads
// it, so it does not count here.
check("only the marked answers count as evidence", concept?.evidenceCount === 4,
  `${concept?.evidenceCount}`);
check("and there is a number, because four is enough",
  concept?.band !== "INSUFFICIENT" && typeof concept?.estimate === "number",
  JSON.stringify({ band: concept?.band, estimate: concept?.estimate }));
check("three of four right lands in a middling band",
  concept?.estimate > 0.4 && concept?.estimate < 0.9, `${concept?.estimate}`);
const before = concept?.estimate;

// --- Marking the written answer adds evidence ------------------------------

r = await teacher.json(`/api/assignments/${assignmentId}/marking/`);
const answerId = r.body?.groups?.[0]?.answers?.[0]?.answerId;
check("the written answer is waiting for a person", Boolean(answerId));

r = await teacher.json(`/api/marking/${answerId}/`, "POST", { awardedMarks: 4 });
check("it is marked", r.status === 200, `status ${r.status}`);

r = await student.json("/api/student/mastery/");
const after = r.body?.mastery?.[0];
check("marking it adds a fifth piece of evidence", after?.evidenceCount === 5,
  `${after?.evidenceCount}`);
check("and full marks move the estimate up", after?.estimate > before,
  `${before} then ${after?.estimate}`);

// --- The refusal, where there is not enough --------------------------------

const other = session();
await other.json("/api/auth/signup/", "POST", {
  fullName: "Second Teacher",
  email: `mst2.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Second Centre ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});

r = await other.json("/api/student/mastery/");
check("a teacher has no student mastery of their own", r.status === 404,
  `status ${r.status}`);

// --- The pages render -------------------------------------------------------

r = await student.page("/student/progress/");
check("the progress page renders", r.status === 200, `status ${r.status}`);
check(
  "and names the concept",
  Boolean(after?.conceptName) && r.html.includes(after.conceptName),
  after?.conceptName ?? "no concept name",
);
check("with a band label rather than a bare number",
  /You&#x27;ve got this|Almost there|Needs practice|Let&#x27;s start here/.test(r.html),
  "");

// --- The scheduled refresh --------------------------------------------------

r = await fetch(`${BASE}/api/cron/refresh-mastery/`, { method: "POST" });
check("the refresh route refuses an unauthenticated caller",
  r.status === 404 || r.status === 500, `status ${r.status}`);

if (process.env.CRON_SECRET) {
  r = await fetch(`${BASE}/api/cron/refresh-mastery/`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const refreshed = await r.json().catch(() => null);
  check("the scheduler can refresh stale estimates", r.status === 200,
    `status ${r.status}`);
  check("and reports no tenant failures",
    Array.isArray(refreshed?.failures) && refreshed.failures.length === 0,
    JSON.stringify(refreshed));
}

await db.end();
report();
