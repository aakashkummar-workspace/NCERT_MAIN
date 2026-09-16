/**
 * End-to-end smoke check for the Mistake Bank.
 *
 *   npm run build && npm start
 *   node scripts/smoke-mistakes.mjs
 *
 * Three properties that need a real HTTP round trip to prove:
 *
 *   1. **The answer is not on the wire before they have had a go.** A GET on a
 *      mistake nobody has retried must not carry the explanation or the key —
 *      not hidden by CSS, absent from the payload.
 *   2. **A student's bank is theirs.** Another student in the same class, on
 *      the same paper, must get 404 on the row and on the retry.
 *   3. **Nothing closes a mistake by hand.** There is no route, and the check
 *      looks for its absence the way the gaps suite does.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-mistakes.mjs");
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

// --- A class, a paper, two students ----------------------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Bank Teacher",
  email: `bank.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Bank Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

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
    name: "Class 10-M",
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

const phones = [0, 1].map((i) => `9${String(stamp + i * 37).slice(-9)}`);
let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: ["Mine", "Theirs"].map((n, i) => `${n} Student, ${phones[i]}`).join("\n"),
});
check("two students are added", r.body?.added === 2, JSON.stringify(r.body));

// Two MCQs on the same concept, so one can be independent proof about the
// other — which is the only way a mistake ever closes.
const questionIds = [];
for (const index of [1, 2]) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: chapter.subjectId,
    chapterId: chapter.id,
    difficulty: "MEDIUM",
    marks: 1,
    stem: `Bank question ${index} for ${stamp} — which criterion proves similarity?`,
    options: [
      { key: "A", text: "The right one", isCorrect: true },
      { key: "B", text: "The wrong one", isCorrect: false },
      { key: "C", text: "Also wrong", isCorrect: false },
    ],
    explanation: `Because the third angle follows. Explanation ${index}.`,
    outcomeIds: [outcome.id],
  });
  await teacher.json(`/api/questions/${created.body.id}/`, "POST", {
    action: "approve",
  });
  questionIds.push(created.body.id);
}

// And a true/false, which a rule settles for free: two options means getting
// it wrong is one bit, and one bit cannot say why.
const tf = await teacher.json("/api/questions/", "POST", {
  type: "TRUE_FALSE",
  subjectId: chapter.subjectId,
  chapterId: chapter.id,
  difficulty: "EASY",
  marks: 1,
  stem: `Bank true/false for ${stamp} — similar triangles always have equal areas.`,
  answerKey: { kind: "boolean", correct: false },
  explanation: "Areas scale with the square of the side ratio.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${tf.body.id}/`, "POST", { action: "approve" });
questionIds.push(tf.body.id);

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Bank paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 30,
  totalMarks: 3,
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
  maxAttempts: 3,
  resultsPolicy: "IMMEDIATE",
});
const assignmentId = r.body?.id;

/**
 * Sit the paper.
 *
 * Answers are chosen by question TYPE and stem, never by served position: the
 * player may shuffle, and a helper that indexed by position would silently put
 * a boolean in a multiple choice and report it as a blank.
 */
async function sit(api, { mcq1, mcq2, tf }) {
  const started = await api.json("/api/attempts/", "POST", {
    assignmentId,
    clientAttemptId: crypto.randomUUID(),
  });
  const player = await api.json(`/api/attempts/${started.body.attemptId}/`);
  const answers = [];
  for (const question of player.body.questions) {
    if (question.type === "TRUE_FALSE") {
      if (tf === undefined) continue;
      answers.push({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "boolean", value: tf },
        clientSeq: 1,
      });
      continue;
    }
    const which = /question 1 /i.test(question.stem) ? mcq1 : mcq2;
    if (which === undefined) continue;
    answers.push({
      assessmentQuestionId: question.assessmentQuestionId,
      response: { kind: "choice", keys: [which] },
      clientSeq: 1,
    });
  }
  if (answers.length > 0) {
    await api.json(`/api/attempts/${started.body.attemptId}/answers/`, "PATCH", {
      answers,
    });
  }
  await api.json(`/api/attempts/${started.body.attemptId}/submit/`, "POST", {
    reason: "MANUAL",
  });
  return started.body.attemptId;
}

// --- One wrong, one blank ---------------------------------------------------

const mine = session();
check("the student signs in", await signInStudent(mine, phones[0]));

r = await mine.json("/api/student/mistakes/");
check("the bank loads and is empty before any test", r.status === 200,
  `status ${r.status}`);
check("with nothing in it", r.body?.mistakes?.length === 0);

// The first MCQ answered wrongly, the second left blank, the true/false wrong.
await sit(mine, { mcq1: "B", tf: true });

r = await mine.json("/api/student/mistakes/");
check("a wrong answer, a blank and a wrong true/false all land in the bank",
  r.body?.mistakes?.length === 3, `${r.body?.mistakes?.length}`);

const bank = r.body.mistakes;
const blank = bank.find((m) => m.mistakeType === "UNATTEMPTED");
const wrong = bank.find((m) => m.mistakeType !== "UNATTEMPTED" && m.marks === 1 && !m.examined);
const binary = bank.find((m) => m.examined && m.mistakeType === "UNCLASSIFIED");

// Free to type, and certain. A blank is a different fact about the student
// from a wrong answer, and flattening the two teaches nothing.
check("the blank is typed by rule, at no cost", Boolean(blank), blank?.mistakeType);
check("and says so in words a student can read",
  /blank/i.test(blank?.typeReason ?? ""), blank?.typeReason ?? "");
check("the summary counts them", r.body?.summary?.open === 3,
  `${r.body?.summary?.open}`);

// Looked at, and there was nothing to say — which is a finding, not a queue
// entry. Reading it as "not looked at yet" would promise the student an answer
// that is never coming, and re-queueing it would pay for that promise nightly.
check("a wrong true/false is settled by rule as having no clear reason",
  Boolean(binary), JSON.stringify(bank.map((m) => [m.mistakeType, m.examined])));
check("with a sentence saying why there is nothing to say",
  /only two answers/i.test(binary?.typeReason ?? ""), binary?.typeReason ?? "");
check("and names the concept most of them are about",
  Boolean(r.body?.summary?.worst?.conceptName),
  r.body?.summary?.worst?.conceptName ?? "");

// --- The answer is not on the wire before they try --------------------------

r = await mine.json(`/api/student/mistakes/${wrong.id}/`);
check("one mistake loads", r.status === 200, `status ${r.status}`);
check("it is not revealed yet", r.body?.revealed === false);
// Absent from the payload, not hidden by CSS. A student with the network tab
// open is the least of it — a payload that carries the answer is one screenshot
// away from being the answer.
check("the explanation is absent from the payload",
  r.body?.explanation === null, String(r.body?.explanation));
check("so is the correct answer", r.body?.correctAnswer === null,
  String(r.body?.correctAnswer));
check("and the options never carry isCorrect",
  !/isCorrect/.test(JSON.stringify(r.body?.options ?? [])));

const page = await mine.page(`/student/mistakes/${wrong.id}/`);
check("the page renders without the answer on it", page.status === 200,
  `status ${page.status}`);
check("and asks them to try before it shows anything",
  page.html.includes("another go before you see the answer"));
check("the rendered HTML does not contain the explanation",
  !page.html.includes("Because the third angle follows"));

// --- Retrying ---------------------------------------------------------------

r = await mine.json(`/api/student/mistakes/${wrong.id}/retry/`, "POST", {
  response: { kind: "choice", keys: ["C"] },
});
check("a wrong retry is accepted and recorded", r.status === 200,
  `status ${r.status}`);
check("and told they are still not right", r.body?.correct === false);
// Not "try again". A second guess now teaches nothing; reading does.
check("pointing them at the explanation rather than another guess",
  /explanation/i.test(r.body?.message ?? ""), r.body?.message ?? "");

r = await mine.json(`/api/student/mistakes/${wrong.id}/`);
check("the answer is revealed once they have had a go",
  r.body?.revealed === true);
check("with the explanation", (r.body?.explanation ?? "").includes("third angle"));
check("and the correct answer in words, not as a key",
  (r.body?.correctAnswer ?? "").includes("The right one"),
  r.body?.correctAnswer ?? "");

r = await mine.json(`/api/student/mistakes/${wrong.id}/retry/`, "POST", {
  response: { kind: "choice", keys: ["A"] },
});
check("a correct retry is accepted", r.body?.correct === true);
// The heart of it. Getting the same question right a second time mostly
// measures memory of the answer, so it is engagement — not proof.
check("but moves it to RETRIED, never to RESOLVED",
  r.body?.status === "RETRIED", r.body?.status);
check("and says why, so nobody is surprised it is still on the list",
  /different question/i.test(r.body?.message ?? ""), r.body?.message ?? "");

// --- Resolution is on independent evidence ----------------------------------

await sit(mine, { mcq1: "A", mcq2: "A", tf: false });

r = await mine.json("/api/student/mistakes/?status=RESOLVED");
check("a different question on the same idea closes them",
  r.body?.mistakes?.length === 3, `${r.body?.mistakes?.length}`);
check("with a date on each", r.body?.mistakes?.every((m) => m.resolvedAt !== null));

r = await mine.json("/api/student/mistakes/");
check("and the open list is empty again", r.body?.mistakes?.length === 0,
  `${r.body?.mistakes?.length}`);
check("with the fixed count kept", r.body?.summary?.resolved === 3,
  `${r.body?.summary?.resolved}`);

// There is deliberately no route that closes one. A bank a student can tidy
// measures how tidy they are.
for (const method of ["DELETE", "PATCH", "PUT"]) {
  const attempt = await fetch(`${BASE}/api/student/mistakes/${wrong.id}/`, {
    method,
  });
  check(`no ${method} route closes a mistake`,
    attempt.status === 404 || attempt.status === 405, `status ${attempt.status}`);
}

// --- A student's bank is theirs ---------------------------------------------

const theirs = session();
check("the second student signs in", await signInStudent(theirs, phones[1]));
await sit(theirs, { mcq1: "B", mcq2: "B", tf: true });

r = await theirs.json("/api/student/mistakes/");
check("they get their own three, not the other student's",
  r.body?.mistakes?.length === 3, `${r.body?.mistakes?.length}`);
check("and none of them is the other student's row",
  !r.body?.mistakes?.some((m) => m.id === wrong.id));

r = await theirs.json(`/api/student/mistakes/${wrong.id}/`);
// Same class, same paper, same question — and still a 404. The row belongs to
// a person, not to a class.
check("a classmate gets 404 on somebody else's mistake", r.status === 404,
  `status ${r.status}`);

r = await theirs.json(`/api/student/mistakes/${wrong.id}/retry/`, "POST", {
  response: { kind: "choice", keys: ["A"] },
});
check("and cannot retry it either", r.status === 404, `status ${r.status}`);

// The teacher is not a student. There is no reason to describe the shape of
// the student API to somebody who is not one.
r = await teacher.json("/api/student/mistakes/");
check("a teacher gets 404 on the student bank", r.status === 404,
  `status ${r.status}`);

r = await fetch(`${BASE}/api/student/mistakes/`);
check("so does an anonymous visitor", r.status === 404, `status ${r.status}`);

// And no route takes a student id. The mistake bank is outside a parent's
// read scope too, and a `?studentId=` would be the first crack in that.
r = await theirs.json(`/api/student/mistakes/?studentId=${wrong.id}`);
check("a studentId in the query string changes nothing",
  r.body?.mistakes?.length === 3, `${r.body?.mistakes?.length}`);

// --- The nightly classifier is gated ----------------------------------------

r = await fetch(`${BASE}/api/cron/classify-mistakes/`, { method: "POST" });
check("the nightly classifier refuses an unauthenticated call",
  r.status === 404 || r.status === 500, `status ${r.status}`);

const pending = await db.query(
  `select count(*)::int as n from student_mistakes
    where type_source = 'PENDING' and organization_id =
      (select id from organizations where name = $1)`,
  [`Bank Centre ${stamp}`],
);
// The whole cost argument. A wrong MCQ that a rule cannot type is the only
// thing that should ever reach a model — the blanks are free, and there were
// as many of those.
check("only the ambiguous ones are waiting on a model", pending.rows[0].n > 0,
  `${pending.rows[0].n} pending`);

const ruled = await db.query(
  `select mistake_type, count(*)::int as n from student_mistakes
    where type_source = 'RULE' and organization_id =
      (select id from organizations where name = $1)
    group by mistake_type`,
  [`Bank Centre ${stamp}`],
);
const byRule = Object.fromEntries(ruled.rows.map((row) => [row.mistake_type, row.n]));
check("and the rest were typed for nothing", ruled.rows.length > 0,
  JSON.stringify(byRule));

// The two claims the cost argument actually rests on. Neither of these should
// ever cost a token: a blank needs no model to be recognised as blank, and a
// true/false carries nothing for one to read.
const neverPending = await db.query(
  `select count(*)::int as n from student_mistakes
    where type_source = 'PENDING'
      and mistake_type = 'UNATTEMPTED'
      and organization_id = (select id from organizations where name = $1)`,
  [`Bank Centre ${stamp}`],
);
check("no blank ever reaches a model", neverPending.rows[0].n === 0,
  `${neverPending.rows[0].n}`);
check("and every blank was typed by rule", (byRule.UNATTEMPTED ?? 0) > 0,
  JSON.stringify(byRule));
check("as was every wrong true/false", (byRule.UNCLASSIFIED ?? 0) > 0,
  JSON.stringify(byRule));

// --- On the page ------------------------------------------------------------

const list = await theirs.page("/student/mistakes/");
check("the bank page renders", list.status === 200, `status ${list.status}`);
check("named for the work, not for the person",
  list.html.includes("Things to fix"));
check("and says how a question gets fixed",
  list.html.includes("different question"));

const home = await theirs.page("/student/");
check("home carries a way in", home.html.includes("/student/mistakes"));
// Home is a dashboard now: a "Things to fix" card with the count, and the
// study plan's first three items under "Up next", where the mistakes item
// carries the count and the concept in the plan's own words. That is what this
// check has always been about.
check("with the count on it",
  /Fix \d+ questions you got wrong|Fix the question you got wrong/.test(home.html),
  "");
check("and the concept most of them are about",
  /(Most of them are about|It is about) /.test(home.html), "");

// Reached from Home, never from the persistent navigation. A standing link
// labelled with your own failures is one a fifteen-year-old learns to skip,
// and UX_FLOW.md puts the entry on Home and on a result for exactly that.
const progress = await theirs.page("/student/progress/");
check("the standing nav did not gain an entry",
  !progress.html.includes("/student/mistakes"), "");

await db.end();
report();
