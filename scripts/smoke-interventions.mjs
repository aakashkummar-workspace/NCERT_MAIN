/**
 * End-to-end smoke check for the gap-to-improvement loop.
 *
 *   npm run build && npm start
 *   node scripts/smoke-interventions.mjs
 *
 * The property this exists to hold: **the baseline is stamped at creation and
 * never moves.** Everything else here — the remedial paper, the targeting, the
 * measurement — is in service of making one claim falsifiable, and a baseline
 * that drifted would make it unfalsifiable without any error appearing anywhere.
 *
 * The second property, which needs a real HTTP round trip to prove: the paper
 * this builds goes to the students who are behind and to nobody else. A class
 * of four where one is fine is the smallest case that can catch the bug.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-interventions.mjs");
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

// --- A class of four, three of whom are behind -----------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Loop Teacher",
  email: `loop.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Loop Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const covered = await db.query(
  "select co.learning_outcome_id as id from concept_outcomes co limit 1",
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
    name: "Class 10-L",
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

const phones = [0, 1, 2, 3].map((i) => `9${String(stamp + i * 23).slice(-9)}`);
let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: ["Anil", "Bina", "Chetan", "Divya"]
    .map((n, i) => `${n} Student, ${phones[i]}`)
    .join("\n"),
});
check("four students are added", r.body?.added === 4, JSON.stringify(r.body));

// A bank with a spread of difficulties, so the calibration has something to
// choose from rather than taking whatever is there.
const questionIds = [];
const difficulties = ["EASY", "EASY", "EASY", "MEDIUM", "MEDIUM", "MEDIUM", "HARD", "HARD"];
for (const [index, difficulty] of difficulties.entries()) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: chapter.subjectId,
    chapterId: chapter.id,
    difficulty,
    marks: 1,
    stem: `Loop question ${index + 1} for ${stamp}`,
    options: [
      { key: "A", text: "The right one", isCorrect: true },
      { key: "B", text: "The wrong one", isCorrect: false },
    ],
    explanation: "Because that is what the definition says.",
    outcomeIds: [outcome.id],
  });
  await teacher.json(`/api/questions/${created.body.id}/`, "POST", {
    action: "approve",
  });
  questionIds.push(created.body.id);
}
check("the bank holds eight approved questions on the concept",
  questionIds.length === 8);

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Loop paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 45,
  totalMarks: 4,
});
await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
  questionIds: questionIds.slice(0, 4),
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

async function sit(phone, correct) {
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

check("three students sit it badly",
  (await sit(phones[0], false)) &&
    (await sit(phones[1], false)) &&
    (await sit(phones[2], false)));
check("and the fourth does well", await sit(phones[3], true));

r = await teacher.json(`/api/classes/${klass.id}/gaps/`);
const gap = r.body?.gaps?.[0];
check("a class gap opens", Boolean(gap), `${r.body?.gaps?.length}`);
check("with three of four affected",
  gap?.affectedStudentCount === 3 && gap?.measuredStudentCount === 4,
  JSON.stringify({ affected: gap?.affectedStudentCount, measured: gap?.measuredStudentCount }));

const baselineFromGap = gap?.meanEstimate;

// --- The plan is shown before it is done -----------------------------------

r = await teacher.json(`/api/gaps/${gap.id}/remedial/`);
check("the remedial plan previews", r.status === 200, `status ${r.status}`);
const plan = r.body;
check("scoped to the students who are behind, not the class",
  plan?.studentUserIds?.length === 3, `${plan?.studentUserIds?.length}`);
check("and to the concept the gap is about",
  plan?.conceptName === gap.conceptName, plan?.conceptName);
// They are a long way behind; a hard question here would only measure that
// again, and would cost them the confidence to try.
check("calibrated with nothing hard for a group this far behind",
  plan?.mix?.HARD === 0, JSON.stringify(plan?.mix));
check("with more easy than medium", plan?.mix?.EASY > plan?.mix?.MEDIUM,
  JSON.stringify(plan?.mix));
check("and enough questions to read something from",
  plan?.chosen?.length >= 4, `${plan?.chosen?.length}`);
check("the preview says it is feasible", plan?.feasible === true,
  JSON.stringify(plan?.problems));

// --- One click ---------------------------------------------------------------

r = await teacher.json(`/api/gaps/${gap.id}/remedial/`, "POST", {
  opensAt: new Date(Date.now() + 60_000).toISOString(),
  closesAt: new Date(Date.now() + hours(72)).toISOString(),
});
check("the paper is built, published and assigned", r.status === 201,
  `status ${r.status} ${JSON.stringify(r.body?.error?.message ?? "")}`);
const built = r.body;
check("to exactly the three who need it", built?.studentCount === 3,
  `${built?.studentCount}`);

const published = await db.query(
  "select status, title from assessments where id = $1",
  [built?.assessmentId],
);
check("the paper went out published, not as a draft",
  published.rows[0]?.status === "PUBLISHED", published.rows[0]?.status);
check("and is named after the concept",
  (published.rows[0]?.title ?? "").includes(gap.conceptName),
  published.rows[0]?.title);

const frozen = await db.query(
  `select count(*)::int as n from assessment_questions
    where assessment_id = $1 and question_version_id is null`,
  [built?.assessmentId],
);
// Publishing freezes the version each question was at. Without it, a question
// edited in December would change what a student saw in September.
check("every question has its version frozen", frozen.rows[0].n === 0,
  `${frozen.rows[0].n} unfrozen`);

const targets = await db.query(
  "select count(*)::int as n from assignment_targets where assignment_id = $1",
  [built?.assignmentId],
);
// Not the whole class. A student who is fine being handed a remedial paper is
// the failure this targeting exists to prevent.
check("three target rows, so the fourth student never sees it",
  targets.rows[0].n === 3, `${targets.rows[0].n}`);

const stored = await db.query(
  `select baseline_mastery, baseline_student_count, target_mastery,
          outcome_mastery, status, kind
     from interventions where id = $1`,
  [built?.interventionId],
);
const row = stored.rows[0];
check("an intervention was stamped in the same call", Boolean(row));
check("with the baseline recorded",
  Math.abs(Number(row?.baseline_mastery) - baselineFromGap) < 0.01,
  `${row?.baseline_mastery} vs ${baselineFromGap}`);
check("and the headcount it was measured over",
  row?.baseline_student_count === 3, `${row?.baseline_student_count}`);
// A target below the threshold that made this a gap would let an intervention
// succeed while the gap stayed open.
check("a target that clears the gap threshold",
  Number(row?.target_mastery) > 0.6, `${row?.target_mastery}`);
check("no outcome yet — null, not zero", row?.outcome_mastery === null,
  `${row?.outcome_mastery}`);

r = await teacher.json(`/api/classes/${klass.id}/gaps/`);
check("the gap now reads as being worked on",
  r.body?.gaps?.[0]?.status === "INTERVENING", r.body?.gaps?.[0]?.status);

// --- A second one is refused while the first is unmeasured -----------------

r = await teacher.json(`/api/gaps/${gap.id}/remedial/`, "POST", {
  opensAt: new Date(Date.now() + 60_000).toISOString(),
  closesAt: new Date(Date.now() + hours(72)).toISOString(),
});
// Two at once and whichever is measured second takes credit for both.
check("a second remedial paper is refused", r.status === 409, `status ${r.status}`);
check("and says why in words a teacher can act on",
  /measure it before/i.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

r = await teacher.json(`/api/gaps/${gap.id}/intervene/`, "POST", {
  kind: "LESSON_PLAN",
});
check("so is recording a second manual one", r.status === 409, `status ${r.status}`);

// --- The baseline does not move --------------------------------------------

const concept = await db.query(
  "select concept_id from learning_gaps where id = $1",
  [gap.id],
);
const students = await db.query(
  `select student_user_id from class_enrolments
    where class_id = $1 and status = 'ACTIVE'`,
  [klass.id],
);

// The lesson happens: the ledger moves underneath the stamp.
await db.query(
  `update student_concept_mastery set estimate = 0.81, band = 'SECURE'
    where concept_id = $1 and student_user_id = any($2::uuid[])`,
  [concept.rows[0].concept_id, students.rows.map((s) => s.student_user_id)],
);

const after = await db.query(
  "select baseline_mastery from interventions where id = $1",
  [built?.interventionId],
);
// If the baseline tracked current mastery, every intervention would forever
// show zero improvement — and nobody would notice, because there would be no
// error.
check("the baseline is unchanged after the mastery moves",
  Number(after.rows[0].baseline_mastery) === Number(row.baseline_mastery),
  `${after.rows[0].baseline_mastery}`);

// --- Measuring --------------------------------------------------------------

r = await teacher.json(`/api/interventions/${built.interventionId}/measure/`, "POST");
check("it measures", r.status === 200, `status ${r.status}`);
check("against the stamp, not against itself",
  Math.abs(r.body?.baseline - Number(row.baseline_mastery)) < 0.001,
  `${r.body?.baseline}`);
check("and finds the improvement", r.body?.delta > 0, `${r.body?.delta}`);
check("which met the target", r.body?.metTarget === true);

r = await teacher.json(`/api/interventions/${built.interventionId}/measure/`, "POST");
// A result that can be re-taken until it is flattering is not a result.
check("measuring twice is refused", r.status === 409, `status ${r.status}`);

for (const method of ["DELETE", "PATCH"]) {
  const attempt = await fetch(`${BASE}/api/interventions/${built.interventionId}/`, {
    method,
  });
  check(`no ${method} route un-measures an intervention`,
    attempt.status === 404 || attempt.status === 405, `status ${attempt.status}`);
}

// --- On the page ------------------------------------------------------------

const page = await teacher.page(`/teacher/analytics/${klass.id}/gaps/`);
check("the gaps page renders", page.status === 200, `status ${page.status}`);
check("with the intervention result on it", page.html.includes("Target met"));
// Both numbers, always. A claim whose baseline is not on screen is a claim
// nobody can check.
check("showing where it started as well as where it got to",
  page.html.includes(`${Math.round(Number(row.baseline_mastery) * 100)}%`) &&
    page.html.includes("81%"),
  "");

// --- A tenant next door sees none of it -------------------------------------

const stranger = session();
await stranger.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `loop.other.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

r = await stranger.json(`/api/gaps/${gap.id}/remedial/`);
check("another organisation cannot preview this gap", r.status === 404,
  `status ${r.status}`);

r = await stranger.json(`/api/interventions/${built.interventionId}/measure/`, "POST");
// 404, not 409. A conflict would confirm the row exists, which is itself the
// leak — the answer has to be identical to one for an id that never existed.
check("nor measure its intervention, and gets a 404 not a 409",
  r.status === 404, `status ${r.status}`);

const untouched = await db.query(
  "select outcome_mastery from interventions where id = $1",
  [built.interventionId],
);
check("and nothing about it changed",
  untouched.rows[0].outcome_mastery !== null);

await db.end();
report();
