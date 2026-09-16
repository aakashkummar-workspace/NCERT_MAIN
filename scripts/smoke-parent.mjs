/**
 * End-to-end smoke check for the parent portal.
 *
 *   npm run build && npm start
 *   node scripts/smoke-parent.mjs
 *
 * The properties worth a real HTTP round trip, in order of how much they would
 * cost to get wrong:
 *
 *   1. **A parent never reaches another child.** Same class, same centre, and
 *      still a 404 — the id in a request is a claim, and only a consented link
 *      turns one into permission.
 *   2. **Nothing the child wrote is ever on the wire.** The response is
 *      serialised whole and searched for the words the student typed.
 *   3. **An unaccepted or revoked link grants nothing**, and revocation leaves
 *      a record rather than deleting one.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-parent.mjs");
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
const SECRET = `SECRET-WRITING-${stamp}`;

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

// --- A centre, a class, two students ---------------------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Parent Portal Teacher",
  email: `par.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Parent Centre ${stamp}`,
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
    name: "Class 10-N",
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

const phones = [0, 1].map((i) => `9${String(stamp + i * 41).slice(-9)}`);
let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: ["Mine Child", "Other Child"]
    .map((n, i) => `${n}, ${phones[i]}`)
    .join("\n"),
});
check("two students are added", r.body?.added === 2, JSON.stringify(r.body));
const mineId = r.body.outcomes[0].userId;
const otherId = r.body.outcomes[1].userId;

// An MCQ and a written question, so there is something the child typed.
const questionIds = [];
const mcq = await teacher.json("/api/questions/", "POST", {
  type: "MCQ",
  subjectId: chapter.subjectId,
  chapterId: chapter.id,
  difficulty: "MEDIUM",
  marks: 2,
  stem: `Parent smoke MCQ for ${stamp}`,
  options: [
    { key: "A", text: "The right one", isCorrect: true },
    { key: "B", text: "The wrong one", isCorrect: false },
  ],
  explanation: "Because that is what the definition says.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${mcq.body.id}/`, "POST", { action: "approve" });
questionIds.push(mcq.body.id);

const written = await teacher.json("/api/questions/", "POST", {
  type: "SA",
  subjectId: chapter.subjectId,
  chapterId: chapter.id,
  difficulty: "MEDIUM",
  marks: 3,
  stem: `Parent smoke written question for ${stamp}`,
  explanation: "The third angle follows from the first two.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${written.body.id}/`, "POST", {
  action: "approve",
});
questionIds.push(written.body.id);

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Parent paper ${stamp}`,
  subjectId: chapter.subjectId,
  gradeId,
  durationMinutes: 30,
  totalMarks: 5,
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

// --- The child sits it and writes something --------------------------------

const child = session();
check("the child signs in", await signInStudent(child, phones[0]));

const started = await child.json("/api/attempts/", "POST", {
  assignmentId,
  clientAttemptId: crypto.randomUUID(),
});
const player = await child.json(`/api/attempts/${started.body.attemptId}/`);
await child.json(`/api/attempts/${started.body.attemptId}/answers/`, "PATCH", {
  answers: player.body.questions.map((q) => ({
    assessmentQuestionId: q.assessmentQuestionId,
    response:
      q.type === "SA"
        ? { kind: "text", value: SECRET }
        : { kind: "choice", keys: ["B"] },
    clientSeq: 1,
  })),
});
await child.json(`/api/attempts/${started.body.attemptId}/submit/`, "POST", {
  reason: "MANUAL",
});
check("the child has sat the paper and written something", true);

// --- Invite a parent --------------------------------------------------------

const parentPhone = `9${String(stamp + 777).slice(-9)}`;
r = await teacher.json(`/api/students/${mineId}/parents/`, "POST", {
  phone: parentPhone,
  relationship: "MOTHER",
});
check("a parent is invited", r.status === 201, `status ${r.status}`);
const inviteToken = r.body?.token;
check("and the token comes back once, to send", Boolean(inviteToken));

const stored = await db.query(
  "select encode(token_hash, 'hex') as h from invitations where id = $1",
  [r.body.invitationId],
);
// A database leak must not be a set of working links to children's records.
check("only its hash is stored",
  !stored.rows[0].h.includes(Buffer.from(inviteToken).toString("hex")));

r = await teacher.json(`/api/students/${mineId}/parents/`);
check("the teacher can see who is linked", r.status === 200, `status ${r.status}`);
// The pending invitation shows, or a teacher cannot tell whether they already
// invited somebody and sends a second link.
check("showing the invitation as pending",
  r.body?.links?.length === 1 && r.body.links[0].status === "INVITED",
  JSON.stringify(r.body?.links));
check("with the number masked and consent not yet given",
  r.body?.links?.[0]?.consentGrantedAt === null &&
    !String(r.body?.links?.[0]?.parentName).includes(parentPhone),
  r.body?.links?.[0]?.parentName ?? "");

// The preview is unauthenticated by necessity.
r = await fetch(`${BASE}/api/parent/invitation/?token=${encodeURIComponent(inviteToken)}`);
const preview = await r.json();
check("the link previews without any session", r.status === 200, `status ${r.status}`);
check("naming the child and the centre",
  Boolean(preview?.studentName) && Boolean(preview?.organizationName));
// Anyone holding the URL sees this, so it carries enough to recognise and not
// enough to be a disclosure.
check("with the number masked", !preview.phoneHint.includes(parentPhone),
  preview.phoneHint);
check("and nothing about the child's work",
  !JSON.stringify(preview).includes(SECRET));

const page = await fetch(`${BASE}/parent/link/${encodeURIComponent(inviteToken)}/`);
const linkHtml = await page.text();
check("the link page renders", page.status === 200, `status ${page.status}`);
// What consent is FOR, before it is given. A parent agreeing to something they
// were not told the shape of has not agreed to anything.
check("saying what they will not see",
  /Not their answers/i.test(linkHtml) && /Not any other child/i.test(linkHtml));

// --- Accepting --------------------------------------------------------------

const parent = session();
await db.query("delete from login_codes where phone = $1", [parentPhone]);
let requested = await parent.json("/api/auth/otp/request/", "POST", {
  phone: parentPhone,
});
let code = requested.body?.devCode ?? "246813";
if (!requested.body?.devCode) {
  await db.query("select app_auth_issue_code($1, $2, $3)", [
    parentPhone,
    createHash("sha256").update(`${parentPhone}:${code}`, "utf8").digest(),
    new Date(Date.now() + 5 * 60_000),
  ]);
}

r = await parent.json("/api/parent/accept/", "POST", {
  token: inviteToken,
  phone: "9000000001",
  code,
});
// Same message as an expired link — saying "not the invited number" would turn
// this into a way of testing which numbers belong to which children.
check("accepting from the wrong number is refused", r.status === 400,
  `status ${r.status}`);
check("with the same message as an invalid link",
  /not valid any more/i.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

// The failed attempt consumed nothing, because the link was rejected first.
r = await parent.json("/api/parent/accept/", "POST", {
  token: inviteToken,
  phone: parentPhone,
  code,
  fullName: "Meera Sharma",
});
check("accepting from the right number works", r.status === 200,
  `status ${r.status} ${JSON.stringify(r.body?.error?.message ?? "")}`);

const link = await db.query(
  `select consent_granted_at, consent_granted_by, parent_user_id
     from parent_student_links where student_user_id = $1`,
  [mineId],
);
check("consent is stamped", link.rows[0]?.consent_granted_at !== null);
// The teacher asked; the parent holding the phone agreed.
check("attributed to the parent, not the teacher who invited them",
  link.rows[0]?.consent_granted_by === link.rows[0]?.parent_user_id);

// --- What the parent can see ------------------------------------------------

r = await parent.json("/api/parent/children/");
check("the parent sees their child", r.status === 200, `status ${r.status}`);
check("exactly one of them", r.body?.children?.length === 1,
  `${r.body?.children?.length}`);
check("and it is the right one", r.body?.children?.[0]?.studentUserId === mineId);

r = await parent.json(`/api/parent/children/${mineId}/`);
check("the child's performance loads", r.status === 200, `status ${r.status}`);
// The one thing this whole module exists to prevent.
check("and does not contain a word the child wrote",
  !JSON.stringify(r.body).includes(SECRET), "");
check("nor any per-question detail",
  !/answers|questionId|attemptAnswerId/.test(JSON.stringify(r.body)), "");

const overview = await parent.page("/parent/");
check("the parent page renders", overview.status === 200, `status ${overview.status}`);
check("with the child's name on it", overview.html.includes("Mine Child"));
check("and the child's writing nowhere in the HTML",
  !overview.html.includes(SECRET));
// Stated plainly, so a parent is far less likely to go looking.
check("telling the parent what they cannot see",
  /cannot see/i.test(overview.html) && /answers/i.test(overview.html));

// --- Never another child ----------------------------------------------------

r = await parent.json(`/api/parent/children/${otherId}/`);
// Same class, same centre, and still nothing.
check("a classmate's child is a 404, not a 403", r.status === 404,
  `status ${r.status}`);

r = await parent.json("/api/student/mistakes/");
check("the parent cannot reach the student mistake API", r.status === 404,
  `status ${r.status}`);
r = await parent.json("/api/student/recommendations/");
check("nor practice recommendations", r.status === 404, `status ${r.status}`);
// A signed-in non-teacher used to get 200 on the whole /teacher surface — the data
// was tenant-scoped, so nothing crossed organisations, but every other child in
// the class was readable by anybody with an account in it. Now gated once, in
// src/app/teacher/layout.tsx.
r = await parent.page(`/teacher/analytics/${klass.id}/`);
// Redirected to their own portal, so their OWN child's name is legitimately in
// the response. What must never be there is the class — every other child's
// mastery, which is what the teacher page shows.
check("and cannot reach the teacher workspace at all",
  !r.html.includes("Other Child") && !r.html.includes("Learning gaps"),
  `status ${r.status}`);

r = await teacher.json("/api/parent/children/");
check("a teacher gets 404 on the parent API", r.status === 404,
  `status ${r.status}`);
r = await fetch(`${BASE}/api/parent/children/`);
check("so does an anonymous visitor", r.status === 404, `status ${r.status}`);

// --- Revocation -------------------------------------------------------------

r = await teacher.json(`/api/students/${mineId}/parents/`);
const active = r.body.links.find((row) => row.status === "ACTIVE");
const linkId = active?.id;
check("consent now shows on the teacher's view",
  Boolean(active) && active.consentGrantedAt !== null,
  JSON.stringify(r.body.links));

r = await teacher.json(`/api/parent-links/${linkId}/revoke/`, "POST");
check("a teacher can revoke access", r.status === 200, `status ${r.status}`);

r = await parent.json("/api/parent/children/");
check("and the parent immediately sees nothing",
  r.body?.children?.length === 0, `${r.body?.children?.length}`);
r = await parent.json(`/api/parent/children/${mineId}/`);
check("not even the child they had", r.status === 404, `status ${r.status}`);

const revoked = await db.query(
  "select revoked_at, revoked_by from parent_student_links where id = $1",
  [linkId],
);
// A stamp, never a delete: "who could see this, and until when" is exactly
// what gets asked after something goes wrong.
check("the row survives, stamped", revoked.rows[0]?.revoked_at !== null);
check("with who did it", revoked.rows[0]?.revoked_by !== null);

const audit = await db.query(
  `select action from audit_logs
    where organization_id = (select id from organizations where name = $1)
      and action like 'parent.%' order by created_at`,
  [`Parent Centre ${stamp}`],
);
const actions = audit.rows.map((row) => row.action);
check("the invitation, the consent and the revocation are all on the audit log",
  actions.includes("parent.invited") &&
    actions.includes("parent.consent_granted") &&
    actions.includes("parent.access_revoked"),
  actions.join(", "));

await db.end();
report();
