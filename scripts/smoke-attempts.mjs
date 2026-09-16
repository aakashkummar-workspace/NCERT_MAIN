/**
 * End-to-end smoke check for the test player.
 *
 *   npm run build && npm start
 *   node scripts/smoke-attempts.mjs
 *
 * This one runs the whole student journey over HTTP — sign in by phone and
 * code, start, answer, resume, submit, submit again — because that is the path
 * the integration tests cannot see: cookies, route guards, JSON shapes and the
 * pages themselves.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-attempts.mjs");
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

/**
 * Prints what was learned before the crash.
 *
 * A smoke script that dies on a stack trace throws away every check that had
 * already run, which is exactly the information needed to find the one that
 * broke.
 */
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

/**
 * Signs a student in.
 *
 * The SMS gateway does not exist yet, so `requestLoginCode` returns the code in
 * the response outside production and keeps it to itself inside. Against a
 * production build there is therefore no way to read a code over HTTP — which
 * is the correct behaviour, and would make this check impossible to write if it
 * only ever spoke HTTP.
 *
 * So it stands in for the gateway: it asks for a code the way the sign-in form
 * does, then, when the response withholds one, plants a code it knows through
 * the same SECURITY DEFINER function the application uses. Everything after
 * that — verify, cookie, session, role — is the real path.
 */
async function signInStudent(client, api, phone) {
  const requested = await api.json("/api/auth/otp/request/", "POST", { phone });
  if (requested.status !== 200) return { ok: false, status: requested.status };

  let code = requested.body?.devCode;
  if (!code) {
    code = "246813";
    // Salted with the phone, exactly as hashCode() in student-auth.ts does. If
    // that ever changes, the verify below fails loudly rather than silently
    // testing nothing.
    const hash = createHash("sha256").update(`${phone}:${code}`, "utf8").digest();
    await client.query(
      "select app_auth_issue_code($1, $2, $3)",
      [phone, hash, new Date(Date.now() + 5 * 60_000)],
    );
  }

  return { ok: true, code, viaGateway: !requested.body?.devCode };
}

const db = new pg.Client({ connectionString: process.env.DIRECT_URL });
await db.connect();

// --- A teacher, a class, a student, a published paper, an open window -------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Player Teacher",
  email: `ply.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Player Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const picker = await teacher.json("/api/curriculum/picker/");
const authored = picker.body.chapters.find((c) => c.outcomeCount > 0);
const outcome = picker.body.outcomes.find((o) => o.chapterId === authored?.id);
check("a chapter with outcomes is available", Boolean(authored && outcome));

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
    name: "Class 10-A",
    gradeId: candidate,
    subjectId: authored.subjectId,
    academicYear: "2026-27",
  });
  if (attempt.status === 200) {
    klass = attempt.body;
    gradeId = candidate;
    break;
  }
}
check("a class is created", Boolean(klass?.id));

// Globally unique, so the check can be re-run against a database that is never
// reset — a hardcoded number passes exactly once and fails forever after.
const phone = `9${String(stamp).slice(-9)}`;
let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: `Sitting Student, ${phone}`,
});
check("a student with a mobile is added", r.body?.added === 1, JSON.stringify(r.body));

const questions = [];
for (const [index, option] of [["A", "B"], ["B", "A"]].entries()) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: authored.subjectId,
    chapterId: authored.id,
    difficulty: "MEDIUM",
    marks: 2,
    stem: `Sitting question ${index + 1} for paper ${stamp}`,
    options: [
      { key: "A", text: "The first choice", isCorrect: option[0] === "A" },
      { key: "B", text: "The second choice", isCorrect: option[0] === "B" },
    ],
    explanation: "Because that is what the definition says.",
    outcomeIds: [outcome.id],
  });
  await teacher.json(`/api/questions/${created.body.id}/`, "POST", {
    action: "approve",
  });
  questions.push({ id: created.body.id, correct: option[0] });
}
check("two approved questions exist", questions.length === 2);

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Sitting paper ${stamp}`,
  subjectId: authored.subjectId,
  gradeId,
  durationMinutes: 45,
  totalMarks: 4,
});
await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
  questionIds: questions.map((q) => q.id),
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
check("the paper is assigned and open now", r.status === 200, `status ${r.status}`);
const assignmentId = r.body?.id;

// --- The student signs in with a phone and a code --------------------------

const student = session();

r = await student.json("/api/auth/otp/verify/", "POST", {
  phone,
  code: "000000",
});
check("a code that was never issued is refused", r.status === 401, `status ${r.status}`);

const issued = await signInStudent(db, student, phone);
check("a code is issued", issued.ok === true, `status ${issued.status ?? ""}`);
const code = issued.code;

const wrong = await student.json("/api/auth/otp/verify/", "POST", {
  phone,
  code: code === "111111" ? "222222" : "111111",
});
check("a wrong code is refused", wrong.status === 401, `status ${wrong.status}`);

// A wrong guess burns an attempt but not the code — five is the limit, and the
// student who fat-fingers one digit must still be able to get in.
r = await student.json("/api/auth/otp/verify/", "POST", { phone, code });
check("the right code signs the student in", r.status === 200, `status ${r.status}`);
check("and the session is a student session", r.body?.role === "STUDENT", r.body?.role);

const reuse = await student.json("/api/auth/otp/verify/", "POST", { phone, code });
check("the code is single use", reuse.status === 401, `status ${reuse.status}`);

// --- A student cannot reach the teacher's product --------------------------

// 403 here, 404 the other way round. The asymmetry is deliberate: a student
// already knows the teacher product exists, so refusing plainly is the honest
// answer — while a teacher poking at a student route learns nothing about its
// shape, because there is no reason to describe it to them.
r = await student.json("/api/classes/");
check("a student cannot list classes", r.status === 403, `status ${r.status}`);

r = await student.json("/api/assignments/");
check("a student cannot list assignments as a teacher would",
  r.status === 403, `status ${r.status}`);

// --- Their own home --------------------------------------------------------

r = await student.json("/api/student/assignments/");
const assigned = r.body?.assignments?.find((a) => a.assignmentId === assignmentId);
check("the paper appears on the student's list", Boolean(assigned));
check("it reads as open", assigned?.status === "OPEN", assigned?.status);
check("it can be started", assigned?.canStart === true);
check("it shows the real question count", assigned?.questionCount === 2,
  `${assigned?.questionCount}`);

r = await student.page("/student/");
check("the student home page renders", r.status === 200, `status ${r.status}`);
check("and names the paper", r.html.includes(`Sitting paper ${stamp}`));

// --- Starting -------------------------------------------------------------

const clientAttemptId = crypto.randomUUID();
r = await student.json("/api/attempts/", "POST", {
  assignmentId,
  clientAttemptId,
});
check("the attempt starts", r.status === 200 && Boolean(r.body?.attemptId),
  `status ${r.status}`);
const attemptId = r.body?.attemptId;

const twice = await student.json("/api/attempts/", "POST", {
  assignmentId,
  clientAttemptId,
});
check("tapping Start twice makes one sitting",
  twice.body?.attemptId === attemptId, `${twice.body?.attemptId}`);

// --- The paper, as the student sees it -------------------------------------

r = await student.json(`/api/attempts/${attemptId}/`);
check("the player loads", r.status === 200, `status ${r.status}`);
check("with both questions", r.body?.questions?.length === 2,
  `${r.body?.questions?.length}`);
check("and time on the clock", r.body?.remainingMs > 0, `${r.body?.remainingMs}`);

const served = JSON.stringify(r.body);
check("the answer key never leaves the server",
  !served.includes("isCorrect") &&
    !served.includes("answerKey") &&
    !served.includes("explanation"));

const placements = r.body.questions;

// --- Autosave --------------------------------------------------------------

r = await student.json(`/api/attempts/${attemptId}/answers/`, "PATCH", {
  answers: [
    {
      assessmentQuestionId: placements[0].assessmentQuestionId,
      response: { kind: "choice", keys: ["B"] },
      clientSeq: 1,
    },
  ],
});
check("an answer saves", r.body?.saved === 1, JSON.stringify(r.body));

// The client's own ordering, not the server's arrival order: a batch delayed
// by a reconnect must not overwrite something newer.
r = await student.json(`/api/attempts/${attemptId}/answers/`, "PATCH", {
  answers: [
    {
      assessmentQuestionId: placements[0].assessmentQuestionId,
      response: { kind: "choice", keys: ["A"] },
      clientSeq: 5,
    },
  ],
});
check("a newer answer replaces it", r.body?.saved === 1);

r = await student.json(`/api/attempts/${attemptId}/answers/`, "PATCH", {
  answers: [
    {
      assessmentQuestionId: placements[0].assessmentQuestionId,
      response: { kind: "choice", keys: ["B"] },
      clientSeq: 2,
    },
  ],
});
check("a stale batch is ignored rather than rejected",
  r.status === 200 && r.body?.ignored === 1, JSON.stringify(r.body));

r = await student.json(`/api/attempts/${attemptId}/answers/`, "PATCH", {
  answers: [
    {
      assessmentQuestionId: placements[1].assessmentQuestionId,
      response: null,
      markedForReview: true,
      clientSeq: 1,
    },
  ],
});
check("a question can be marked for review with no answer", r.body?.saved === 1);

// --- Resume ----------------------------------------------------------------

r = await student.json(`/api/attempts/${attemptId}/`);
const first = r.body.questions.find(
  (q) => q.assessmentQuestionId === placements[0].assessmentQuestionId,
);
const second = r.body.questions.find(
  (q) => q.assessmentQuestionId === placements[1].assessmentQuestionId,
);
check("reloading the player returns the saved answer",
  first?.response?.keys?.[0] === "A", JSON.stringify(first?.response));
check("and the review flag", second?.markedForReview === true);

r = await student.page(`/student/attempt/${attemptId}/`);
check("the player page renders", r.status === 200, `status ${r.status}`);

// --- The clock -------------------------------------------------------------

r = await student.json(`/api/attempts/${attemptId}/heartbeat/`, "POST");
check("the heartbeat returns authoritative server time",
  r.status === 200 && Boolean(r.body?.serverTime) && Boolean(r.body?.expiresAt),
  `status ${r.status}`);
const drift = Math.abs(new Date(r.body.serverTime).getTime() - Date.now());
check("and it is close to real time", drift < 60_000, `${drift}ms`);

// --- Another student cannot touch this sitting -----------------------------

const intruderPhone = `8${String(stamp).slice(-9)}`;
await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: `Nosy Student, ${intruderPhone}`,
});
const intruder = session();
const intruderSignIn = await signInStudent(db, intruder, intruderPhone);
r = await intruder.json("/api/auth/otp/verify/", "POST", {
  phone: intruderPhone,
  code: intruderSignIn.code,
});
check("a second student signs in", r.status === 200, `status ${r.status}`);

r = await intruder.json(`/api/attempts/${attemptId}/`);
check("another student cannot read this paper", r.status === 404, `status ${r.status}`);

r = await intruder.json(`/api/attempts/${attemptId}/answers/`, "PATCH", {
  answers: [
    {
      assessmentQuestionId: placements[0].assessmentQuestionId,
      response: { kind: "choice", keys: ["B"] },
      clientSeq: 99,
    },
  ],
});
check("nor write to it", r.status === 404, `status ${r.status}`);

r = await intruder.json(`/api/attempts/${attemptId}/submit/`, "POST", {
  reason: "MANUAL",
});
check("nor submit it", r.status === 404, `status ${r.status}`);

// --- Submitting ------------------------------------------------------------

r = await student.json(`/api/attempts/${attemptId}/submit/`, "POST", {
  reason: "MANUAL",
});
check("the paper submits", r.status === 200, `status ${r.status}`);
check("and returns a score, because the policy is IMMEDIATE",
  r.body?.showResult === true && typeof r.body?.rawScore === "number",
  JSON.stringify(r.body));

const answeredCorrectly = questions[0].correct === "A";
check("the marked score matches the answer given",
  r.body?.rawScore === (answeredCorrectly ? 2 : 0),
  `${r.body?.rawScore} (correct key was ${questions[0].correct})`);
check("an untouched question is not counted as wrong, only unscored",
  r.body?.maxScore === 4, `${r.body?.maxScore}`);

const again = await student.json(`/api/attempts/${attemptId}/submit/`, "POST", {
  reason: "MANUAL",
});
check("submitting twice is a 200, not a 409", again.status === 200,
  `status ${again.status}`);
check("and says so rather than pretending it was the first time",
  again.body?.alreadySubmitted === true);
check("the score does not change on a retry",
  again.body?.rawScore === r.body?.rawScore);

// A queued flush arriving after submission must not error — the client that
// sent it was offline when the paper closed and did nothing wrong.
const late = await student.json(`/api/attempts/${attemptId}/answers/`, "PATCH", {
  answers: [
    {
      assessmentQuestionId: placements[1].assessmentQuestionId,
      response: { kind: "choice", keys: ["A"] },
      clientSeq: 900,
    },
  ],
});
check("a late flush after submission is accepted quietly", late.status === 200,
  `status ${late.status}`);

// --- The result ------------------------------------------------------------

r = await student.page(`/student/results/${attemptId}/`);
check("the result page renders", r.status === 200, `status ${r.status}`);
check("and shows the paper title", r.html.includes(`Sitting paper ${stamp}`));

r = await student.page(`/student/attempt/${attemptId}/`);
check("reopening a finished paper lands on the result, not an error",
  r.status === 200 && r.html.includes(`Sitting paper ${stamp}`),
  `status ${r.status}`);

r = await student.json("/api/student/assignments/");
const finished = r.body?.assignments?.find((a) => a.assignmentId === assignmentId);
check("the home list now offers no second sitting", finished?.canStart === false);
check("and the result is visible", finished?.resultVisible === true);

// --- The scheduled sweep ---------------------------------------------------

r = await fetch(`${BASE}/api/cron/sweep-attempts/`, { method: "POST" });
check("the cron route refuses an unauthenticated caller",
  r.status === 404 || r.status === 500, `status ${r.status}`);

r = await fetch(`${BASE}/api/cron/sweep-attempts/`, {
  method: "POST",
  headers: { authorization: "Bearer definitely-not-the-secret" },
});
check("and a wrong secret gets the same answer as no secret",
  r.status === 404 || r.status === 500, `status ${r.status}`);

if (process.env.CRON_SECRET) {
  r = await fetch(`${BASE}/api/cron/sweep-attempts/`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const swept = await r.json().catch(() => null);
  check("the scheduler can run the sweep", r.status === 200, `status ${r.status}`);
  // Nothing is expired right now, so the interesting assertion is that it
  // completed cleanly rather than that it found work.
  //
  // Scoped to THIS script's organization, as the integration sweep test is:
  // a raw bulk SQL statement on 11 September 2026 moved ~36,000 test
  // questions out from under older test organizations' papers, and the
  // sweep correctly reports those tenants as failing forever. That damage
  // is left alone on purpose (CLAUDE.md, "The NCERT import"); what this
  // check proves is that a healthy tenant sweeps cleanly and that one broken
  // tenant does not stop the rest — which `organizations` still counts.
  const mine = await db.query("select id from organizations where name = $1", [
    `Player Centre ${stamp}`,
  ]);
  const ownId = mine.rows[0]?.id;
  check("and it reports no failure for this organization",
    Array.isArray(swept?.failures) && Boolean(ownId) &&
      !swept.failures.some((failure) => failure.organizationId === ownId),
    `${swept?.failures?.length ?? "?"} failures elsewhere, across ${swept?.organizations ?? "?"} organizations`);
}

await db.end();
report();
