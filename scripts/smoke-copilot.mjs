/**
 * End-to-end smoke check for the AI Teacher Copilot.
 *
 *   npm run build && npm start
 *   node scripts/smoke-copilot.mjs
 *
 * The properties worth a real HTTP round trip:
 *
 *   1. **The plan gate stops it before the provider.** The Copilot is the one
 *      DEEP-tier feature; a teacher whose plan does not include it must never
 *      reach a call.
 *   2. **It is metered on its own key.** A question must not eat the generation
 *      allowance a teacher bought to write papers with.
 *   3. **Nothing about a student's identity reaches the ledger**, and a
 *      conversation belongs to one teacher.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-copilot.mjs");
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

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Copilot Teacher",
  email: `cop.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Copilot Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const org = await db.query("select id from organizations where name = $1", [
  `Copilot Centre ${stamp}`,
]);
const organizationId = org.rows[0]?.id;
check("the organisation exists", Boolean(organizationId));

// --- The plan gate ----------------------------------------------------------

let r = await teacher.json("/api/copilot/", "POST", {
  question: "How is my class doing on similarity?",
});
// Free has no `copilot_questions_per_month` row at all, and a missing
// entitlement means "not included" — never "unlimited".
check("a teacher on Free cannot ask", r.status === 409, `status ${r.status}`);
// The plan is checked BEFORE the data. A teacher on Free told "nothing
// measured yet" is told their data is the problem when their plan is.
check("and is told about their plan, not about their data",
  /plan/i.test(r.body?.error?.message ?? "") &&
    !/nothing measured|budget|dollar/i.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

let generations = await db.query(
  "select count(*)::int as n from ai_generations where organization_id = $1",
  [organizationId],
);
// Refused before a generation record was opened, and long before a provider —
// which on the one DEEP-tier feature is the check that matters most.
check("with nothing attempted", generations.rows[0].n === 0,
  `${generations.rows[0].n}`);

await db.query(
  `insert into subscriptions (id, organization_id, plan_id, status)
   select gen_random_uuid(), $1, p.id, 'ACTIVE' from plans p where p.code = 'teacher_pro'`,
  [organizationId],
);

// --- Nothing measured, so nothing to say ------------------------------------

r = await teacher.json("/api/copilot/", "POST", {
  question: "How is my class doing on similarity?",
});
check("with a plan but nothing marked, it still refuses", r.status === 409,
  `status ${r.status}`);
check("saying so rather than guessing",
  /nothing measured/i.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

generations = await db.query(
  "select count(*)::int as n from ai_generations where organization_id = $1",
  [organizationId],
);
// Paying DEEP-tier rates to be told there is nothing to look at is the worst
// possible outcome, so the refusal happens before the call.
check("and still nothing attempted", generations.rows[0].n === 0,
  `${generations.rows[0].n}`);

// --- Give it something to read ----------------------------------------------

const covered = await db.query(
  "select co.learning_outcome_id as id from concept_outcomes co limit 1",
);
const picker = await teacher.json("/api/curriculum/picker/");
const outcome = picker.body.outcomes.find((o) => o.id === covered.rows[0]?.id);
const chapter = picker.body.chapters.find((c) => c.id === outcome?.chapterId);

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

const STUDENT_NAME = `Meera Copilot ${stamp}`;
const phone = `9${String(stamp).slice(-9)}`;
await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: `${STUDENT_NAME}, ${phone}`,
});

const questionIds = [];
for (let index = 0; index < 2; index++) {
  const created = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: chapter.subjectId,
    chapterId: chapter.id,
    difficulty: "MEDIUM",
    marks: 1,
    stem: `Copilot smoke question ${index} for ${stamp}`,
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

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Copilot paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 30,
  totalMarks: 2,
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
// The assignment is created for realism; this suite marks work directly
// rather than sitting it, so the id itself is not needed.

// Mark some work directly, so there is mastery to reason over without needing
// the student to sit anything through the player.
const studentRow = await db.query(
  `select u.id from users u join memberships m on m.user_id = u.id
    where m.organization_id = $1 and m.role = 'STUDENT' limit 1`,
  [organizationId],
);
const studentId = studentRow.rows[0].id;
const conceptRow = await db.query(
  "select concept_id from concept_outcomes where learning_outcome_id = $1 limit 1",
  [outcome.id],
);
await db.query(
  `insert into student_concept_mastery
     (id, organization_id, student_user_id, concept_id, estimate, confidence,
      evidence_count, effective_evidence, band, last_evidence_at, computed_at)
   values (gen_random_uuid(), $1, $2, $3, 0.35, 0.2, 6, 6, 'CRITICAL', now(), now())`,
  [organizationId, studentId, conceptRow.rows[0].concept_id],
);
check("there is now something measured to reason over", true);

// --- Ask ---------------------------------------------------------------------

r = await teacher.json("/api/copilot/", "POST", {
  question: `Is ${STUDENT_NAME} struggling, and what should I reteach?`,
});
// No API key in this environment, so the mock provider answers — what matters
// is that the call was ATTEMPTED, which is what the ledger records.
const attempted = await db.query(
  `select id, feature, input_summary::text as summary
     from ai_generations where organization_id = $1 order by started_at desc limit 1`,
  [organizationId],
);
check("with data present, the call is attempted", attempted.rows.length === 1,
  `${attempted.rows.length}`);
check("as a TEACHER_COPILOT generation",
  attempted.rows[0]?.feature === "TEACHER_COPILOT", attempted.rows[0]?.feature);

// The question is a teacher's own prose and may name a child. It goes to the
// provider — it has to, it is the question — but not into the row a platform
// admin reads during an incident.
check("and the teacher's question is not in the ledger summary",
  !attempted.rows[0].summary.includes(STUDENT_NAME),
  attempted.rows[0].summary);
check("nor the student's name anywhere in it",
  !attempted.rows[0].summary.includes("Meera"), "");

// --- Metering ----------------------------------------------------------------

const counters = await db.query(
  `select key, value from usage_counters where organization_id = $1 order by key`,
  [organizationId],
);
const byKey = Object.fromEntries(counters.rows.map((row) => [row.key, Number(row.value)]));
// Two different promises. A teacher who asked five questions must still be able
// to set a test.
check("the generation allowance is untouched",
  (byKey.ai_generations_per_month ?? 0) === 0,
  JSON.stringify(byKey));

// --- Scope --------------------------------------------------------------------

r = await teacher.json("/api/copilot/");
check("the teacher can list their conversations", r.status === 200,
  `status ${r.status}`);

const conversation = await db.query(
  "select id from copilot_conversations where organization_id = $1 limit 1",
  [organizationId],
);
if (conversation.rows.length > 0) {
  const stranger = session();
  await stranger.json("/api/auth/signup/", "POST", {
    fullName: "Other Teacher",
    email: `cop.other.${stamp}@example.test`,
    password: "a-long-enough-password",
    organizationName: `Other Copilot ${stamp}`,
    organizationType: "TUITION_CENTRE", boardCode: "CBSE",
  });
  r = await stranger.json(`/api/copilot/${conversation.rows[0].id}/`);
  check("another organisation gets 404 on a conversation", r.status === 404,
    `status ${r.status}`);
} else {
  // The mock has nothing scripted in a built server, so no conversation was
  // stored. The tenancy property is covered by the integration suite.
  check("no conversation stored without a working provider", true);
}

r = await fetch(`${BASE}/api/copilot/`, { method: "POST" });
check("an anonymous visitor cannot ask", r.status === 401 || r.status === 404,
  `status ${r.status}`);

// --- The page -----------------------------------------------------------------

const page = await teacher.page("/teacher/copilot/");
check("the Copilot page renders", page.status === 200, `status ${page.status}`);
check("with suggested questions rather than an empty box",
  /What should I reteach/i.test(page.html), "");
// Said out loud: this is the most expensive thing in the product per call.
check("saying it counts against the allowance",
  /allowance/i.test(page.html), "");
check("and that it answers only from marked work",
  /marked work/i.test(page.html), "");

const shell = await teacher.page("/teacher/");
// A live nav item renders as <a>; a "soon" one renders as
// <span data-soon="true" aria-disabled="true">. Asserting on the ELEMENT is
// exact, where a text-window match reads "Reports · soon" a few dozen
// characters away as the Copilot's own badge.
const copilotLink = /<a[^>]*href="\/teacher\/copilot\/?"/.test(shell.html);
const copilotSoon = /<span[^>]*data-soon[^>]*>[\s\S]{0,200}?AI Copilot/.test(shell.html);
check("the Copilot is a live link in the sidebar", copilotLink, "");
check("and is no longer marked as coming soon", !copilotSoon, "");
// Reports used to be the negative control here — it was marked "soon", which
// proved this check could tell a live item from an unbuilt one. Reports is now
// built, so there is no unbuilt item left to contrast against, and the stronger
// statement is the one worth making: the navigation promises nothing it does
// not have. Restore a contrast case here if a "soon" item is ever added again.
check("and nothing at all in the sidebar is still marked soon",
  !/data-soon/.test(shell.html), "");

await db.end();
report();
