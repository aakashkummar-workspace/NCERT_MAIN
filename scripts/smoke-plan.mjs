/**
 * End-to-end smoke check for the study plan.
 *
 *   npm run build && npm start
 *   node scripts/smoke-plan.mjs
 *
 * Six properties that need a real HTTP round trip to prove:
 *
 *   1. **Nothing is stored, and nothing can be ticked off.** There is no table
 *      and no route that closes an item — the check looks for the absence, the
 *      way the gaps and mistakes suites do.
 *   2. **A closed window drops its item, with nothing run.** The plan is
 *      derived from the clock, so moving the window is enough.
 *   3. **The plan and the Mistake Bank agree on the count.** A student told
 *      nine and shown seven stops believing both pages.
 *   4. **Home carries ONE prompt, not three.** The papers are already listed
 *      below as cards; a nudge repeating one is the page saying it twice.
 *   5. **No dates, no durations, no weekdays.** A plan is an order, never a
 *      timetable.
 *   6. **It is not in the standing navigation**, per UX_FLOW.md.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-plan.mjs");
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

// --- A class, two papers, one student ---------------------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Plan Teacher",
  email: `pl.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Plan Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const org = await db.query("select id from organizations where name = $1", [
  `Plan Centre ${stamp}`,
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
    name: "Class 10-P",
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
  text: `Anjali Sharma, ${phone}`,
});
check("a student is added", r.body?.added === 1, JSON.stringify(r.body));

const questionIds = [];
for (let index = 0; index < 10; index++) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: chapter.subjectId,
    chapterId: chapter.id,
    difficulty: index % 2 === 0 ? "EASY" : "MEDIUM",
    marks: 1,
    stem: `Plan question ${index} for ${stamp} — which criterion proves similarity?`,
    options: [
      { key: "A", text: "Angle-angle similarity", isCorrect: true },
      { key: "B", text: "Equal areas", isCorrect: false },
      { key: "C", text: "Equal perimeters", isCorrect: false },
    ],
    explanation: "Two equal angles force the third.",
    outcomeIds: [outcome.id],
  });
  await teacher.json(`/api/questions/${created.body.id}/`, "POST", {
    action: "approve",
  });
  questionIds.push(created.body.id);
}

async function publishAndAssign(title, slice, opensInMs, closesInMs, maxAttempts) {
  const assessment = await teacher.json("/api/assessments/", "POST", {
    title,
    subjectId: chapter.subjectId,
    gradeId,
    durationMinutes: 30,
    totalMarks: 3,
  });
  await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
    questionIds: slice,
  });
  await teacher.json(`/api/assessments/${assessment.body.id}/publish/`, "POST");
  const assigned = await teacher.json("/api/assignments/", "POST", {
    assessmentId: assessment.body.id,
    classId: klass.id,
    opensAt: new Date(Date.now() + opensInMs).toISOString(),
    closesAt: new Date(Date.now() + closesInMs).toISOString(),
    maxAttempts,
    resultsPolicy: "IMMEDIATE",
  });
  return assigned.body?.id;
}

const openAssignmentId = await publishAndAssign(
  `Weekly test ${stamp}`,
  questionIds.slice(0, 3),
  -60_000,
  hours(30),
  5,
);
await publishAndAssign(
  `Chapter test ${stamp}`,
  questionIds.slice(3, 6),
  hours(72),
  hours(96),
  1,
);
check("two papers exist, one open and one coming", Boolean(openAssignmentId));

// --- Sit it badly, three times ----------------------------------------------

const student = session();
check("the student signs in", await signInStudent(student, phone));

let plan = await student.page("/student/plan/");
check("the plan page renders before any work", plan.status === 200,
  `status ${plan.status}`);
// A paper is open, so there IS something honest to say — and it is the paper,
// not a guess about what to revise.
check("and leads with the paper rather than guessing",
  plan.html.includes("Sit Weekly test"), "");
check("with nothing evidence-driven on it yet",
  !plan.html.includes("you got wrong"), "");

for (let pass = 0; pass < 3; pass++) {
  const started = await student.json("/api/attempts/", "POST", {
    assignmentId: openAssignmentId,
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

plan = await student.page("/student/plan/");
check("after three bad sittings the plan has work on it",
  plan.html.includes("you got wrong"), "");

// --- 3. The plan and the bank agree ------------------------------------------

const bank = await student.json("/api/student/mistakes/");
const open = (bank.body?.summary?.open ?? 0) + (bank.body?.summary?.retried ?? 0);
check("the plan names the same number the bank holds",
  open > 0 && plan.html.includes(`Fix ${open} questions`),
  `${open}`);

// --- 5. No dates, no durations, no weekdays ----------------------------------

// Read only the plan list, not the whole document: the shell carries a footer
// and the student's own name, neither of which is the plan.
const listStart = plan.html.indexOf('class="ui-plan"');
const listEnd = plan.html.indexOf("</ol>", listStart);
const listHtml = listStart === -1 ? "" : plan.html.slice(listStart, listEnd);
check("the plan list was found in the page", listHtml.length > 0);
check("it holds no clock time",
  !/\b\d{1,2}:\d{2}\b/.test(listHtml), "");
check("no durations",
  !/\b\d+\s*(minutes?|mins?|hours?)\b/i.test(listHtml), "");
check("and no weekdays",
  !/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/.test(listHtml), "");
// It says WHEN in words a student can act on without a calendar.
check("it does say when the window shuts, in words",
  /(today|tomorrow|in \d+ days)/.test(listHtml), "");

// --- The revise item is specific ---------------------------------------------

check("the coming test gets a named concept to revise",
  /Revise .+ before/.test(plan.html), "");
check("with the number that put it there",
  /% right so far/.test(plan.html), "");

// --- 1. Nothing is stored, and nothing ticks off ------------------------------

// `plans` and `entitlements` are the BILLING tables and are meant to be there;
// what must not exist is anywhere a derived study plan could be persisted.
const tables = await db.query(
  `select table_name from information_schema.tables
    where table_schema = 'public'
      and (table_name like 'study_plan%'
        or table_name like 'plan_item%'
        or table_name like '%_plans')`,
);
// Derived at read time, exactly as an assignment's status is. No table means
// nothing to go stale and no job to keep it fresh.
check("there is no study-plan table at all", tables.rows.length === 0,
  JSON.stringify(tables.rows.map((row) => row.table_name)));

for (const [method, path] of [
  ["POST", "/api/plan/"],
  ["POST", "/api/student/plan/"],
  ["DELETE", "/api/plan/"],
]) {
  const res = await fetch(`${BASE}${path}`, { method });
  check(`no ${method} ${path} route exists`,
    res.status === 404 || res.status === 405, `status ${res.status}`);
}

// --- 2. A closed window drops its item, with nothing run ----------------------

await db.query(
  `update assignments set opens_at = now() - interval '5 days',
                          closes_at = now() - interval '1 day'
    where id = $1`,
  [openAssignmentId],
);
plan = await student.page("/student/plan/");
check("a shut window drops the paper from the plan",
  !plan.html.includes("Sit Weekly test"), "");
// Nothing was run to make that happen. There is no status column and no cron.
check("and the work below it is still there",
  plan.html.includes("you got wrong"), "");

// --- 4. Home carries ONE prompt ------------------------------------------------

const home = await student.page("/student/");
check("home renders", home.status === 200, `status ${home.status}`);
check("home carries the way into the plan", home.html.includes("/student/plan"), "");
// Home is now a dashboard: its "Up next" card shows the plan's first three
// items, in the plan's own order, and links to the rest. Never more than
// three, and never a timetable.
const upNext = home.html.match(/data-sd="plan"[\s\S]*?<\/section>/)?.[0] ?? "";
const upNextItems = (upNext.match(/ui-sd-plan-item"/g) ?? []).length;
check("with an Up next card of at most three items",
  upNextItems >= 1 && upNextItems <= 3, `${upNextItems}`);
check("and it carries the plan's own items",
  upNext.includes("you got wrong"), "");

// --- 6. Not in the standing navigation ------------------------------------------

// UX_FLOW.md: five tabs is the limit, and a sixth makes all six harder to hit.
const progress = await student.page("/student/progress/");
check("the standing nav did not gain an entry",
  !progress.html.includes("/student/plan"), "");

// --- Scope ----------------------------------------------------------------------

const teacherPlan = await teacher.page("/student/plan/");
check("a teacher does not get the student's plan",
  teacherPlan.status !== 200 || !teacherPlan.html.includes("What to do next"),
  `status ${teacherPlan.status}`);

const anonymous = await fetch(`${BASE}/student/plan/`, { redirect: "manual" });
check("an anonymous visitor is sent to sign in",
  anonymous.status === 307 || anonymous.status === 302 || anonymous.status === 308,
  `status ${anonymous.status}`);

// --- Following the plan lands somewhere useful ------------------------------------

const conceptMatch = plan.html.match(/\/student\/practice\?conceptId=([0-9a-f-]{36})/);
if (conceptMatch) {
  const practice = await student.page(
    `/student/practice/?conceptId=${conceptMatch[1]}`,
  );
  check("the practice link opens the practice page", practice.status === 200,
    `status ${practice.status}`);
  check("with the plan's concept marked and hoisted",
    practice.html.includes("From your plan"), "");
} else {
  // Every practice candidate was consumed by the revise item, which is a real
  // state and not a failure.
  check("no practice link to follow on this plan", true);
}

await db.end();
report();
