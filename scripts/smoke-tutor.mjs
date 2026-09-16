/**
 * End-to-end smoke check for the student tutor.
 *
 *   npm run build && npm start
 *   node scripts/smoke-tutor.mjs
 *
 * Five properties that need a real HTTP round trip to prove:
 *
 *   1. **The plan is asked before the question.** A school without the tutor on
 *      its plan hears about the plan, and no money is spent finding that out.
 *   2. **The allowance is its own.** A student asking for help must not eat the
 *      teacher's question generations.
 *   3. **The route takes no student id.** `?studentId=` would be the first
 *      crack in the boundary this feature depends on, so the check looks for
 *      its absence the way the mistake-bank suite does.
 *   4. **Nothing about the child reaches the ledger.** Not their name, not
 *      their own wrong answer — a platform admin reading a row during an
 *      incident is not looking for either.
 *   5. **The panel says what it is for**, on the page, before it is pressed.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-tutor.mjs");
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
const STUDENT_NAME = "Anjali Tutor";

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

// --- A class, a paper, one student ------------------------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Tutor Teacher",
  email: `tut.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Tutor Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const org = await db.query("select id from organizations where name = $1", [
  `Tutor Centre ${stamp}`,
]);
const organizationId = org.rows[0]?.id;
check("the organisation exists", Boolean(organizationId));

const covered = await db.query(
  "select co.learning_outcome_id as id from concept_outcomes co limit 1",
);
const picker = await teacher.json("/api/curriculum/picker/");
const outcome = picker.body.outcomes.find((o) => o.id === covered.rows[0]?.id);
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
    name: "Class 10-T",
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
  text: `${STUDENT_NAME}, ${phone}`,
});
check("a student is added", r.body?.added === 1, JSON.stringify(r.body));

const created = await teacher.json("/api/questions/", "POST", {
  type: "MCQ",
  subjectId: chapter.subjectId,
  chapterId: chapter.id,
  difficulty: "MEDIUM",
  marks: 1,
  stem: `Tutor question ${stamp} — which criterion proves the triangles similar?`,
  options: [
    { key: "A", text: "Angle-angle similarity", isCorrect: true },
    { key: "B", text: "Equal areas", isCorrect: false },
    { key: "C", text: "Equal perimeters", isCorrect: false },
  ],
  hint: "Count how many facts you have been given before you pick anything.",
  explanation: "Two equal angles force the third, so the shapes match.",
  outcomeIds: [outcome.id],
});
const questionId = created.body?.id;
await teacher.json(`/api/questions/${questionId}/`, "POST", { action: "approve" });
check("a question with an authored hint exists", Boolean(questionId));

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Tutor paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 20,
  totalMarks: 1,
});
await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
  questionIds: [questionId],
});
await teacher.json(`/api/assessments/${assessment.body.id}/publish/`, "POST");

r = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  opensAt: new Date(Date.now() - 60_000).toISOString(),
  closesAt: new Date(Date.now() + hours(24)).toISOString(),
  maxAttempts: 3,
  resultsPolicy: "IMMEDIATE",
});
const assignmentId = r.body?.id;

// --- Get it wrong, so there is a mistake to ask about ------------------------

const student = session();
check("the student signs in", await signInStudent(student, phone));

const started = await student.json("/api/attempts/", "POST", {
  assignmentId,
  clientAttemptId: crypto.randomUUID(),
});
const player = await student.json(`/api/attempts/${started.body.attemptId}/`);
await student.json(`/api/attempts/${started.body.attemptId}/answers/`, "PATCH", {
  answers: [
    {
      assessmentQuestionId: player.body.questions[0].assessmentQuestionId,
      response: { kind: "choice", keys: ["B"] },
      clientSeq: 1,
    },
  ],
});
await student.json(`/api/attempts/${started.body.attemptId}/submit/`, "POST", {
  reason: "MANUAL",
});

r = await student.json("/api/student/mistakes/");
const mistakeId = r.body?.mistakes?.[0]?.id;
check("the wrong answer lands in the bank", Boolean(mistakeId));

// --- 1. The plan, before the question ----------------------------------------

// A fresh organisation has no subscription, so it gets the free shape — which
// has no tutor row at all, and a missing entitlement is "not included".
r = await student.json("/api/tutor/", "POST", { questionId });
check("without the tutor on the plan, the ask is refused", r.status === 409,
  `status ${r.status}`);
check("and says so in terms of the plan, not of missing data",
  /plan/i.test(r.body?.error?.message ?? ""), r.body?.error?.message ?? "");

const spentOnRefusal = await db.query(
  "select count(*)::int as n from ai_generations where organization_id = $1",
  [organizationId],
);
check("a refusal costs nothing — the model was never reached",
  spentOnRefusal.rows[0].n === 0, `${spentOnRefusal.rows[0].n}`);

// --- Put them on a plan that includes it -------------------------------------

const plan = await db.query("select id from plans where code = 'teacher_pro'");
await db.query(
  `insert into subscriptions
     (id, organization_id, plan_id, status, current_period_start, created_at, updated_at)
   values (gen_random_uuid(), $1, $2, 'ACTIVE', now(), now(), now())`,
  [organizationId, plan.rows[0].id],
);

const entitled = await db.query(
  `select e.limit_value from entitlements e
    where e.plan_id = $1 and e.key = 'tutor_hints_per_month'`,
  [plan.rows[0].id],
);
check("the plan carries its own tutor allowance", entitled.rows.length === 1,
  JSON.stringify(entitled.rows));

// --- 2. Asking ----------------------------------------------------------------

r = await student.json("/api/tutor/", "POST", { questionId, studentMistakeId: mistakeId });
// No API key in this environment, so the mock provider answers with nothing
// scripted — what matters is that the call was ATTEMPTED, which the ledger
// records either way.
const attempted = await db.query(
  `select id, feature, input_summary::text as summary
     from ai_generations where organization_id = $1 order by started_at desc limit 1`,
  [organizationId],
);
check("with the plan allowing it, the call is attempted",
  attempted.rows.length === 1, `${attempted.rows.length}`);
check("as a STUDENT_TUTOR generation",
  attempted.rows[0]?.feature === "STUDENT_TUTOR", attempted.rows[0]?.feature);

// --- 3. Nothing about the child on the wire to us -----------------------------

check("the child's name is not in the ledger summary",
  !attempted.rows[0].summary.includes(STUDENT_NAME), attempted.rows[0].summary);
check("nor their first name on its own",
  !attempted.rows[0].summary.includes("Anjali"), "");
// Their own attempt at a question is the most personal thing this feature
// touches. It goes to the provider because it is what the help is about; it
// does not go into a row a platform admin reads during an incident.
check("nor what they actually put",
  !/Equal areas/i.test(attempted.rows[0].summary), attempted.rows[0].summary);

// --- 4. The allowance is its own ---------------------------------------------

const counters = await db.query(
  `select key, value from usage_counters where organization_id = $1 order by key`,
  [organizationId],
);
const byKey = Object.fromEntries(
  counters.rows.map((row) => [row.key, Number(row.value)]),
);
check("the teacher's generation allowance is untouched",
  (byKey.ai_generations_per_month ?? 0) === 0, JSON.stringify(byKey));
check("and so is the Copilot's",
  (byKey.copilot_questions_per_month ?? 0) === 0, JSON.stringify(byKey));

// --- 5. Scope ------------------------------------------------------------------

// The teacher is not a student, and there is no reason to describe the shape of
// the student API to somebody who is not one.
r = await teacher.json("/api/tutor/", "POST", { questionId });
check("a teacher gets 404 on the tutor route", r.status === 404, `status ${r.status}`);

r = await teacher.json(`/api/tutor/${questionId}/`);
check("and 404 reading a student's help", r.status === 404, `status ${r.status}`);

const anonymous = await fetch(`${BASE}/api/tutor/`, { method: "POST" });
check("an anonymous visitor cannot ask",
  anonymous.status === 401 || anonymous.status === 404, `status ${anonymous.status}`);

// The route takes no student id and never will. Same rule as the mistake bank:
// `?studentId=` would be the first crack in the boundary.
r = await student.json(`/api/tutor/?studentId=${crypto.randomUUID()}`);
check("the read route ignores a studentId entirely",
  r.status === 404 || r.status === 405, `status ${r.status}`);

// A second organisation's student must not read this one's help.
const stranger = session();
await stranger.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `tut.other.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Tutor ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});
r = await stranger.json(`/api/tutor/${questionId}/`);
check("another organisation's teacher sees nothing", r.status === 404,
  `status ${r.status}`);

// --- 6. On the page ------------------------------------------------------------

const detail = await student.page(`/student/mistakes/${mistakeId}/`);
check("the mistake page renders", detail.status === 200, `status ${detail.status}`);
check("and carries the help panel", detail.html.includes("ui-help"),
  `status ${detail.status}`);
// Stated before it is pressed. A student who expects the answer and does not
// get one concludes the feature is broken.
check("which says up front that it will not give the answer",
  /will not tell you the answer/i.test(detail.html), "");
// The hint was already given above — with no API key, from the question's own
// authored hint — so the ladder offers exactly the next rung and nothing past it.
check("and offers the next rung by name, not a bare Help button",
  detail.html.includes("Show me the steps"), "");
check("the explanation is NOT offered before the steps",
  !detail.html.includes("Explain it differently"), "");

// The answer is still not on the wire. The tutor panel must not be a way round
// the retry gate the mistake bank puts in front of the explanation.
check("the answer is still withheld on the page",
  !detail.html.includes("Two equal angles force the third"), "");

const bank = await student.page("/student/mistakes/");
check("the bank page still renders", bank.status === 200, `status ${bank.status}`);

// --- 7. No route closes anything, and none escalates on demand ------------------

// The level is the server's decision. A client that could ask for EXPLAIN first
// could skip the hint, which is the whole ladder.
r = await student.json("/api/tutor/", "POST", { questionId, level: "EXPLAIN" });

// Read from the LEDGER, not from tutor_turns: with no API key the mock writes
// no turn, and a check over an empty table passes without proving anything.
// The generation row is written whatever the provider does, and it carries the
// level the server chose.
const asked = await db.query(
  `select input_summary::text as summary from ai_generations
    where organization_id = $1 and feature = 'STUDENT_TUTOR'
    order by started_at desc limit 1`,
  [organizationId],
);
// The client asked for EXPLAIN; one hint has been given, so the server's rung
// is STEPS. Anything else means the client chose the level.
check("a level asked for by the client is ignored",
  /"level":\s*"STEPS"/.test(asked.rows[0]?.summary ?? ""),
  asked.rows[0]?.summary ?? "no generation");

// And every turn that did get written stayed on the ladder.
const levels = await db.query(
  `select t.level from tutor_turns t
     join tutor_sessions s on s.id = t.session_id
    where s.organization_id = $1 order by t.created_at asc`,
  [organizationId],
);
check("no turn was ever written above the rung the server chose",
  levels.rows.every((row) => row.level !== "EXPLAIN"),
  JSON.stringify(levels.rows.map((row) => row.level)));

await db.end();
report();
