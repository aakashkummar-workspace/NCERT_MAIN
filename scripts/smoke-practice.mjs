/**
 * End-to-end smoke check for personalised practice.
 *
 *   npm run build && npm start
 *   node scripts/smoke-practice.mjs
 *
 * Three properties that need a real HTTP round trip:
 *
 *   1. **No answers on the wire before they answer.** A GET on a fresh set must
 *      carry no explanation, no key, and no `isCorrect` on any option.
 *   2. **The verdict comes back with the answer**, per question — answering the
 *      third must not unseal the rest.
 *   3. **Practice counts, and counts for less.** Evidence lands stamped
 *      PRACTICE at a reduced weight, and only when the set is finished.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-practice.mjs");
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

// --- A class, a stocked bank, one student ----------------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Practice Teacher",
  email: `prac.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Practice Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const covered = await db.query(
  "select co.learning_outcome_id as id, co.concept_id from concept_outcomes co limit 1",
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
  text: `Practice Student, ${phone}`,
});
check("a student is added", r.body?.added === 1, JSON.stringify(r.body));

// Twelve on the concept: two for the paper, ten to practise with.
const questionIds = [];
for (let index = 0; index < 12; index++) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: chapter.subjectId,
    chapterId: chapter.id,
    difficulty: ["EASY", "MEDIUM", "HARD"][index % 3],
    marks: 1,
    stem: `Practice smoke question ${index} for ${stamp}`,
    options: [
      { key: "A", text: "The right one", isCorrect: true },
      { key: "B", text: "The wrong one", isCorrect: false },
    ],
    explanation: `Because of the reason for question ${index}.`,
    outcomeIds: [outcome.id],
  });
  await teacher.json(`/api/questions/${created.body.id}/`, "POST", {
    action: "approve",
  });
  questionIds.push(created.body.id);
}
check("the bank holds twelve approved questions", questionIds.length === 12);

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Practice paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 30,
  totalMarks: 2,
});
await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
  questionIds: questionIds.slice(0, 2),
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

// --- Nothing measured, nothing suggested ------------------------------------

r = await student.json("/api/student/recommendations/");
check("recommendations load before any test", r.status === 200, `status ${r.status}`);
// The refusal is data, not an empty list: "we do not know you yet" and "you are
// on top of everything" are opposite facts.
check("and refuse rather than guess", r.body?.ok === false, JSON.stringify(r.body?.reason));
check("saying so in words a student can act on",
  /sit a test/i.test(r.body?.message ?? ""), r.body?.message ?? "");

// --- Sit the paper badly, three times ---------------------------------------

async function sit(correct) {
  const started = await student.json("/api/attempts/", "POST", {
    assignmentId,
    clientAttemptId: crypto.randomUUID(),
  });
  const player = await student.json(`/api/attempts/${started.body.attemptId}/`);
  await student.json(`/api/attempts/${started.body.attemptId}/answers/`, "PATCH", {
    answers: player.body.questions.map((q) => ({
      assessmentQuestionId: q.assessmentQuestionId,
      response: { kind: "choice", keys: [correct ? "A" : "B"] },
      clientSeq: 1,
    })),
  });
  await student.json(`/api/attempts/${started.body.attemptId}/submit/`, "POST", {
    reason: "MANUAL",
  });
}
for (let pass = 0; pass < 3; pass++) await sit(false);

r = await student.json("/api/student/recommendations/");
check("now there is something to suggest", r.body?.ok === true,
  JSON.stringify(r.body?.reason ?? ""));
const candidate = r.body?.candidates?.[0];
check("named by concept", Boolean(candidate?.conceptName), candidate?.conceptName);
// A recommendation a student cannot interrogate is one they stop trusting the
// first time it is wrong.
check("with a reason built from their own numbers",
  (candidate?.rationale ?? "").includes(candidate?.conceptName ?? "@"),
  candidate?.rationale ?? "");
check("and a set length that fits the bank",
  candidate?.questionCount >= 4 && candidate?.questionCount <= 10,
  `${candidate?.questionCount}`);

// --- Start a set ------------------------------------------------------------

r = await student.json("/api/practice/sessions/", "POST", {
  conceptId: candidate.conceptId,
  source: "RECOMMENDED",
  questionCount: candidate.questionCount,
});
check("a set opens", r.status === 201, `status ${r.status}`);
const sessionId = r.body?.sessionId;

r = await student.json("/api/practice/sessions/", "POST", {
  conceptId: candidate.conceptId,
  source: "RECOMMENDED",
});
// On a phone, backgrounding and re-tapping happens constantly.
check("tapping again resumes it rather than opening a second",
  r.body?.sessionId === sessionId, `${r.body?.sessionId}`);

r = await student.json(`/api/practice/sessions/${sessionId}/`);
check("the set loads", r.status === 200, `status ${r.status}`);
const questions = r.body?.questions ?? [];
// One at a time. Each next question is chosen from how the set has actually
// gone, so it does not exist until the current one is answered.
check("serving one question at a time", questions.length === 1,
  `${questions.length}`);
check("with the count it is aiming for",
  r.body?.questionCount === candidate.questionCount,
  `${r.body?.questionCount}`);

// Absent from the payload, not hidden by CSS.
check("no explanation on the wire before they answer",
  questions.every((q) => q.explanation === null));
check("no correct answer either",
  questions.every((q) => q.correctAnswer === null));
check("and the options never carry isCorrect",
  !/isCorrect/.test(JSON.stringify(questions.map((q) => q.options))));

const page = await student.page(`/student/practice/${sessionId}/`);
check("the runner renders", page.status === 200, `status ${page.status}`);
check("with no timer on it", !/id="timer"|ui-timer/.test(page.html));
check("and no explanation in the HTML",
  !page.html.includes("Because of the reason for question"));

// --- Answer one, and be told at once ---------------------------------------

r = await student.json(`/api/practice/sessions/${sessionId}/answers/`, "POST", {
  practiceAnswerId: questions[0].practiceAnswerId,
  response: { kind: "choice", keys: ["B"] },
  timeSpentSeconds: 12,
});
const answered = r.body;
check("answering returns the verdict immediately", r.status === 200,
  `status ${r.status}`);
check("saying it was wrong", r.body?.correct === false);
// The whole reason the screen exists — it arrives while their own reasoning is
// still in their head.
check("with the explanation", (r.body?.explanation ?? "").includes("Because of the reason"));
check("and the answer in words, not as a key",
  (r.body?.correctAnswer ?? "").includes("The right one"),
  r.body?.correctAnswer ?? "");

r = await student.json(`/api/practice/sessions/${sessionId}/answers/`, "POST", {
  practiceAnswerId: questions[0].practiceAnswerId,
  response: { kind: "choice", keys: ["A"] },
});
// A set a student could walk until every verdict was green would make practice
// evidence worthless.
check("answering the same one twice is refused", r.status === 409, `status ${r.status}`);

r = await student.json(`/api/practice/sessions/${sessionId}/`);
const reloaded = r.body?.questions ?? [];
check("the answered question is now unsealed",
  reloaded[0]?.explanation !== null);
// Per question, not per session. The next one was served with the verdict and
// arrives sealed.
check("but the one served after it is not",
  reloaded.slice(1).every((q) => q.explanation === null && q.correctAnswer === null));
check("and it arrived with the verdict, so there is no second round trip",
  Boolean(answered?.next), "");

// --- Half done credits nothing ----------------------------------------------

const org = await db.query("select id from organizations where name = $1", [
  `Practice Centre ${stamp}`,
]);
let evidence = await db.query(
  "select count(*)::int as n from concept_evidence where organization_id = $1 and source = 'PRACTICE'",
  [org.rows[0].id],
);
// Crediting the ones answered before the tab closed would reward starting over
// finishing.
check("a half-done set has written no evidence", evidence.rows[0].n === 0,
  `${evidence.rows[0].n}`);

// --- Finish it --------------------------------------------------------------

// Answer whatever is open, then whatever gets served next, until it is over.
// Bounded so a bug that never finishes fails rather than hangs.
let servedDifficulties = [];
for (let guard = 0; guard < 30; guard++) {
  const view = await student.json(`/api/practice/sessions/${sessionId}/`);
  const open = (view.body?.questions ?? []).find((q) => q.isCorrect === null);
  if (!open) break;
  servedDifficulties.push(open.stem);
  const step = await student.json(
    `/api/practice/sessions/${sessionId}/answers/`,
    "POST",
    {
      practiceAnswerId: open.practiceAnswerId,
      response: { kind: "choice", keys: ["A"] },
      timeSpentSeconds: 20,
    },
  );
  if (step.body?.finished) break;
}
// Every question in the set was a different one — the adaptation picks from
// what has not been served, so a set never repeats itself.
check("no question was served twice in one set",
  new Set(servedDifficulties).size === servedDifficulties.length,
  `${servedDifficulties.length} served`);

r = await student.json(`/api/practice/sessions/${sessionId}/`);
check("the set completes", r.body?.completedAt !== null);
check("with a score", typeof r.body?.score === "number", `${r.body?.score}`);

evidence = await db.query(
  `select source, count(*)::int as n, max(weight) as max_weight
     from concept_evidence where organization_id = $1 group by source`,
  [org.rows[0].id],
);
const bySource = Object.fromEntries(
  evidence.rows.map((row) => [row.source, row]),
);
check("finishing writes practice evidence", (bySource.PRACTICE?.n ?? 0) > 0,
  JSON.stringify(bySource.PRACTICE ?? null));
// At full weight, mastery becomes a function of persistence — and a gap that
// closed because somebody ground questions at home is a lesson not taught.
check("weighted below an exam answer",
  Number(bySource.PRACTICE?.max_weight) <= 0.4,
  `${bySource.PRACTICE?.max_weight}`);
check("while assessment evidence stays at full weight",
  Number(bySource.ASSESSMENT?.max_weight) === 1,
  `${bySource.ASSESSMENT?.max_weight}`);

const mastery = await db.query(
  "select estimate from student_concept_mastery where organization_id = $1",
  [org.rows[0].id],
);
// It counts — otherwise a PRACTICE_SET intervention could never be measured as
// having worked, which is the product's own North Star.
check("the estimate moved", Number(mastery.rows[0]?.estimate) > 0,
  `${mastery.rows[0]?.estimate}`);

// --- The cooldown -----------------------------------------------------------

r = await student.json("/api/practice/sessions/", "POST", {
  conceptId: candidate.conceptId,
  source: "SELF_SELECTED",
});
check("a second set opens", r.status === 201, `status ${r.status}`);
const secondId = r.body?.sessionId;

r = await student.json(`/api/practice/sessions/${secondId}/`);
const secondStems = new Set((r.body?.questions ?? []).map((q) => q.stem));
const firstCorrect = new Set(reloaded.slice(1).map((q) => q.stem));
// Repeating what you can already do is the least useful minute in revision —
// and it is what would let a student grind four questions until the estimate
// said whatever they wanted.
check("none of the ones they just got right come back",
  [...firstCorrect].every((stem) => !secondStems.has(stem)),
  `${secondStems.size} served`);
// The one they got wrong is fair game again.
check("but the one they got wrong does",
  secondStems.has(reloaded[0].stem), reloaded[0].stem);

// --- Scope ------------------------------------------------------------------

r = await teacher.json("/api/student/recommendations/");
check("a teacher gets 404 on the student's recommendations", r.status === 404,
  `status ${r.status}`);

r = await fetch(`${BASE}/api/practice/sessions/${sessionId}/`);
check("an anonymous visitor gets 404 on a set", r.status === 404,
  `status ${r.status}`);

const stranger = session();
await stranger.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `prac.other.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Practice ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});
r = await stranger.json(`/api/practice/sessions/${sessionId}/`);
check("and so does another organisation", r.status === 404, `status ${r.status}`);

// --- On the page ------------------------------------------------------------

const list = await student.page("/student/practice/");
check("the practice page renders", list.status === 200, `status ${list.status}`);
// The promise lives in the page header, not only on a card — a card for a
// concept with a set already open is correctly hidden, and the promise must
// not go with it.
check("promising it is untimed", /untimed|no timer/i.test(list.html));
// Said plainly, so nobody is surprised by their progress page later.
check("and that practice counts for less than a test",
  /less than a test/i.test(list.html));

const home = await student.page("/student/");
check("home carries a way in", home.html.includes("/student/practice"));
check("with the reason on it, not a generic prompt",
  home.html.includes("Practice ") && /getting about|not fixed yet|some of the time/i.test(home.html),
  "");

// --- Practice a teacher asked for ------------------------------------------
//
// The instruction is the only thing this adds: everything the student then
// does is the practice checked above. So what is worth a round trip here is
// that it refuses what the bank cannot honour, that it reaches the student's
// own surfaces, and that withdrawing it takes it away again.

const conceptId = covered.rows[0].concept_id;

// A concept in the same subject that this school holds no questions on. The
// refusal is the interesting half: a card on thirty home pages that cannot be
// honoured is what it exists to prevent, and it names the number rather than
// saying "not enough".
const barren = await db.query(
  `select distinct co.concept_id as id
     from concept_outcomes co
     join learning_outcomes lo on lo.id = co.learning_outcome_id
     join topics t on t.id = lo.topic_id
     join chapters ch on ch.id = t.chapter_id
    where ch.subject_id = $1 and co.concept_id <> $2
    limit 1`,
  [chapter.subjectId, conceptId],
);
if (barren.rows[0]) {
  r = await teacher.json(`/api/classes/${klass.id}/practice/`, "POST", {
    conceptId: barren.rows[0].id,
    questionCount: 5,
  });
  check("an idea the bank cannot honour is refused", r.status === 409,
    `status ${r.status}`);
  check("saying so in a sentence a teacher can act on",
    /bank holds (no|\d+) practice question/i.test(r.body?.error?.message ?? ""),
    r.body?.error?.message);
}

const dueOn = new Date(Date.now() + hours(48)).toISOString().slice(0, 10);
r = await teacher.json(`/api/classes/${klass.id}/practice/`, "POST", {
  conceptId,
  questionCount: 5,
  dueOn,
  note: "Before Thursday's lesson.",
});
check("practice can be set for the class", r.status === 201, `status ${r.status}`);
const assignedId = r.body?.id;

r = await student.json(`/api/classes/${klass.id}/practice/`, "POST", {
  conceptId,
  questionCount: 5,
});
// Setting work for a class is a teacher's act, and a student does not hold the
// permission it needs — the same refusal every other write on a class makes.
check("a student cannot set practice for their own class", r.status === 403,
  `status ${r.status}`);

let practicePage = await student.page("/student/practice/");
check("the set appears on the student's practice page",
  practicePage.html.includes("Set by your"), "");
check("saying which class's teacher asked",
  practicePage.html.includes("Class 10-P"), "");
// It is practice, and the card says so before they start: no timer, no marks.
check("and that it carries no timer and no marks",
  /no timer/i.test(practicePage.html) && /no marks/i.test(practicePage.html), "");
check("with the note the teacher typed",
  practicePage.html.includes("Before Thursday"), "");

const planPage = await student.page("/student/plan/");
check("the study plan lists it", planPage.html.includes(`assigned=${assignedId}`),
  "");
check("labelled as something their teacher set",
  /set by your teacher/i.test(planPage.html), "");
// A due date orders the plan. It never scolds: an overdue set still counts.
for (const scolding of [/overdue/i, /you are late/i, /missed/i]) {
  check(`the plan does not scold (${scolding.source})`,
    !scolding.test(planPage.html), "");
}

// The teacher's own view: counts, and never a score.
const classPage = await teacher.page(`/teacher/classes/${klass.id}/`);
check("the class page lists what was set", /Set practice/i.test(classPage.html));
// React puts a comment between two adjacent expressions, so the counted
// sentence arrives as `0<!-- --> of <!-- -->1 done` in the HTML.
const classHtml = classPage.html.replace(/<!--\s*-->/g, "");
check("as how many have done it, of how many enrolled",
  /0 of 1 done/.test(classHtml), "");
// Counts, never a score: there is no mark here to show, and a marks column is
// the one thing this feature must not grow.
check("and never as a score",
  !/(?:^|[^A-Za-z])marks?(?:[^A-Za-z]|$)/i.test(
    classHtml.split("Set practice")[1]?.slice(0, 2000) ?? "",
  ),
  "");

r = await teacher.json(`/api/classes/${klass.id}/practice/`, "DELETE", {
  assignedPracticeId: assignedId,
});
check("it can be withdrawn", r.status === 200, `status ${r.status}`);

practicePage = await student.page("/student/practice/");
check("and stops appearing for the student",
  !practicePage.html.includes("Set by your"), "");

r = await teacher.json(`/api/classes/${klass.id}/practice/`, "DELETE", {
  assignedPracticeId: assignedId,
});
// A stamp, not a delete — so withdrawing twice is not a second withdrawal.
check("withdrawing it twice is not a second withdrawal", r.status === 404,
  `status ${r.status}`);

await db.end();
report();
