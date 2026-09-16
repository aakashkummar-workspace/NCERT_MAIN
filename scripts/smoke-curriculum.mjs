/**
 * End-to-end smoke check for the curriculum plane and the platform console.
 *
 *   npm run build && npm start
 *   node scripts/smoke-curriculum.mjs
 *
 * Covers the boundary that matters: an ordinary teacher must not be able to
 * reach the console, or the routes behind it, at all.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-curriculum.mjs");
import pg from "pg";
import {
  databaseNow,
  fixtureChapterNumber,
  removeFixtureCurriculum,
} from "./lib/fixture-curriculum.mjs";

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
const stamp = Date.now();

function session() {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
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

// --- Two accounts: one ordinary teacher, one platform admin -----------------
const teacher = session();
const teacherEmail = `teacher.${stamp}@example.test`;
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Ordinary Teacher",
  email: teacherEmail,
  password: "a-long-enough-password",
  organizationName: `Teacher Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const admin = session();
const adminEmail = `admin.${stamp}@example.test`;
await admin.json("/api/auth/signup/", "POST", {
  fullName: "Platform Person",
  email: adminEmail,
  password: "a-long-enough-password",
  organizationName: `Platform Org ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});

// --- A teacher cannot reach the console ------------------------------------
let r = await teacher.page("/admin/curriculum/");
check(
  "an ordinary teacher gets 404 on the platform console, not 403",
  r.status === 404,
  `status ${r.status}`,
);

r = await teacher.json("/api/admin/curriculum/topics/", "POST", {
  chapterId: "00000000-0000-4000-8000-000000000000",
  title: "Injected",
});
check(
  "an ordinary teacher cannot call the curriculum write route",
  r.status === 404,
  `status ${r.status}`,
);

// --- Promote, then sign in again so the session carries the flag -----------
const client = new pg.Client({ connectionString: process.env.DIRECT_URL });
await client.connect();
await client.query(
  `update users set platform_admin = true where lower(email) = lower($1)`,
  [adminEmail],
);
// A chapter with no outcomes, AUTHORED here. The check below used to rely on
// one existing somewhere, which stopped being true the day the NCERT drafts
// gave every real chapter outcomes — a fact about the database, not about the
// console. Numbered as a fixture, so the end of this script removes it.
const since = await databaseNow(client);
await client.query(
  `insert into chapters (id, subject_id, number, title, source)
   select gen_random_uuid(), s.id, $1, 'Smoke chapter with no outcomes', 'smoke-curriculum.mjs — removed at the end of the run'
     from subjects s join grades g on g.id = s.grade_id join boards b on b.id = g.board_id
    where s.code = 'MATH' and g.number = 10 and b.code = 'CBSE'`,
  [fixtureChapterNumber()],
);

const promoted = session();
r = await promoted.json("/api/auth/signin/", "POST", {
  identifier: adminEmail,
  password: "a-long-enough-password",
});
check("platform admin signs in", r.status === 200, `status ${r.status}`);

r = await promoted.page("/admin/curriculum/");
check("platform admin reaches the console", r.status === 200, `status ${r.status}`);
check("console lists both class years", r.html.includes("Class 9") && r.html.includes("Class 10"));
// Either badge is a pass, and that is the point of the check.
//
// It used to assert /need outcomes/ alone, on the reasoning that 50 chapters
// are unauthored by design. That is a fact about the DATABASE, not about the
// console, and this database is never reset: other suites author outcomes as
// arrangement until eventually every chapter has some, at which point the
// console correctly renders "All chapters authored" and a check about
// reporting failed for a reason that had nothing to do with reporting.
//
// What is actually under test is that the console STATES the coverage rather
// than leaving it to be discovered as an empty analytics page six months
// later. Both badges do that.
check(
  "console reports outcome coverage per subject",
  /need outcomes/.test(r.html) || /All chapters authored/.test(r.html),
);

// --- The seeded tree --------------------------------------------------------
// Hrefs render as /admin/curriculum/<uuid>/ — trailingSlash is on — so the match
// stops at the id rather than expecting a closing quote right after it.
const subjectIds = [
  ...new Set(
    [...r.html.matchAll(/\/admin\/curriculum\/([0-9a-f-]{36})/g)].map((m) => m[1]),
  ),
];
check("subjects are linked from the console", subjectIds.length >= 10, `${subjectIds.length}`);

let mathsPage = null;
// Whether ANY subject still shows the marker. Checked across every subject
// rather than against Mathematics specifically: outcomes are authored, and
// several suites author them, so which subject still has a bare chapter drifts
// with what has been run. What must hold is that the console SURFACES a
// chapter with no outcomes — a state the product treats as designed, not
// broken, and therefore has to keep visible.
let anyNeedsOutcomes = false;
for (const id of subjectIds) {
  const page = await promoted.page(`/admin/curriculum/${id}/`);
  if (page.html.includes("Needs outcomes")) anyNeedsOutcomes = true;
  if (page.html.includes("Real Numbers")) mathsPage = page;
}
check("Class 10 Mathematics chapters are seeded", mathsPage !== null);
check(
  "the chapter list shows a chapter that still needs outcomes",
  anyNeedsOutcomes,
);

// --- The worked example -----------------------------------------------------
const chapterIds = [
  ...(mathsPage?.html.matchAll(/\/admin\/curriculum\/chapter\/([0-9a-f-]{36})/g) ?? []),
].map((m) => m[1]);

let triangles = null;
for (const id of chapterIds) {
  const page = await promoted.page(`/admin/curriculum/chapter/${id}/`);
  if (page.html.includes("Similar figures")) {
    triangles = { id, ...page };
    break;
  }
}
check("the worked-example chapter is authored", triangles !== null);
check(
  "its outcome statements are shown in full",
  triangles?.html.includes("AA, SSS and SAS") ?? false,
);
check(
  "the chapter records where it came from",
  triangles?.html.includes("NCERT textbook contents") ?? false,
);

// --- Authoring --------------------------------------------------------------
const bare = chapterIds.find((id) => id !== triangles?.id);
r = await promoted.json("/api/admin/curriculum/topics/", "POST", {
  chapterId: bare,
  title: `Smoke topic ${stamp}`,
});
check("platform admin adds a topic", r.status === 200 && !!r.body.id, `status ${r.status}`);
const topicId = r.body?.id;

r = await promoted.json("/api/admin/curriculum/outcomes/", "POST", {
  topicId,
  code: `SM-${stamp % 1000}`,
  statement:
    "Applies the division algorithm to find the highest common factor of two positive integers.",
  bloomLevel: "APPLY",
  competency: "APPLICATION",
  typicalMarks: 2,
});
check("a good outcome saves and passes the quality check", r.body?.quality?.ok === true);

r = await promoted.json("/api/admin/curriculum/outcomes/", "POST", {
  topicId,
  code: `WK-${stamp % 1000}`,
  statement: "The chapter is about real numbers and their many uses in algebra.",
  bloomLevel: "UNDERSTAND",
  competency: "UNDERSTANDING",
  typicalMarks: 1,
});
check(
  "a weak outcome still saves but is flagged, not silently accepted",
  r.status === 200 && r.body?.quality?.ok === false,
  r.body?.quality?.reason ?? "",
);

r = await promoted.json("/api/admin/curriculum/outcomes/", "POST", {
  topicId,
  code: `SM-${stamp % 1000}`,
  statement:
    "Applies the division algorithm to find the highest common factor of two positive integers.",
  bloomLevel: "APPLY",
  competency: "APPLICATION",
  typicalMarks: 2,
});
check("a duplicate outcome code is refused", r.status === 409, `status ${r.status}`);

r = await promoted.json(`/api/admin/curriculum/topics/${topicId}/`, "DELETE");
check(
  "deleting a topic reports what went with it",
  r.status === 200 && r.body.outcomesRemoved === 2,
  `removed ${r.body?.outcomesRemoved}`,
);

// --- A teacher still sees curriculum, read-only -----------------------------
r = await teacher.page("/teacher/classes/new/");
check(
  "a teacher still reads the curriculum for their own class picker",
  r.status === 200 && r.html.includes("Mathematics"),
);

await removeFixtureCurriculum(client, since);
await client.end();

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
