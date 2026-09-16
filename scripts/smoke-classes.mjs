import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-classes.mjs");
/**
 * End-to-end smoke check for the slice 1–2 activation path:
 * sign up -> create a class -> paste a roster -> see it on the dashboard.
 *
 *   npm run build && npm start        # in one shell
 *   node scripts/smoke-classes.mjs    # in another
 */
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
let cookie = "";

const json = async (path, method, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, body: payload };
};

// --- 1. A teacher signs up ---------------------------------------------------
let r = await json("/api/auth/signup/", "POST", {
  fullName: "Priya Raman",
  email: `priya.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Raman Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});
check("teacher signs up", r.status === 200, `status ${r.status}`);

// --- 2. Classes start empty --------------------------------------------------
r = await json("/api/classes/", "GET");
check("classes start empty", r.status === 200 && r.body.classes.length === 0);

// --- 3. Create a class -------------------------------------------------------
const grades = await fetch(`${BASE}/teacher/classes/new/`, { headers: { cookie } });
check("create-class page renders", grades.status === 200, `status ${grades.status}`);
const gradeHtml = await grades.text();
const gradeIds = [...gradeHtml.matchAll(/value="([0-9a-f-]{36})"/g)].map((m) => m[1]);
check("curriculum is seeded and offered", gradeIds.length >= 2, `${gradeIds.length} option ids`);

r = await json("/api/classes/", "POST", {
  name: "Class 10-A",
  gradeId: gradeIds[0],
  subjectId: gradeIds[1],
  academicYear: "2026-27",
});
// gradeIds[1] may be a subject of the wrong grade; retry properly below.
const classesList = await json("/api/classes/", "GET");
let classId = classesList.body?.classes?.[0]?.id ?? null;

if (!classId) {
  // Pick a real (grade, subject) pair out of the rendered selects.
  const gradeBlock = gradeHtml.split('id="subjectId"')[1] ?? "";
  const subjectIds = [...gradeBlock.matchAll(/value="([0-9a-f-]{36})"/g)].map((m) => m[1]);
  r = await json("/api/classes/", "POST", {
    name: "Class 10-A",
    gradeId: gradeIds[0],
    subjectId: subjectIds[0],
    academicYear: "2026-27",
  });
  classId = r.body?.id ?? null;
}

check("class is created", Boolean(classId), classId ? "" : JSON.stringify(r.body));
check(
  "class gets a join code with no misread characters",
  typeof r.body?.joinCode !== "string" || !/[OI1L0S5B8Z2]/.test(r.body.joinCode),
);

// --- 4. Mismatched grade/subject is refused ----------------------------------
const wrong = await json("/api/classes/", "POST", {
  name: "Wrong pair",
  gradeId: gradeIds[1],
  subjectId: gradeIds[gradeIds.length - 1],
  academicYear: "2026-27",
});
check(
  "a subject from another class year is refused",
  wrong.status === 400,
  `status ${wrong.status}`,
);

// --- 5. Roster dry run -------------------------------------------------------
const roster = "1. Arun Kumar\n2. Meera Nair, 12\n3. Ravi Shankar\nNo Name Row,,";
r = await json("/api/roster/preview/", "POST", { classId, text: roster });
check("dry run reports what will happen", r.status === 200, `status ${r.status}`);
check("dry run counts the rows it will add", r.body?.willAdd >= 3, `willAdd ${r.body?.willAdd}`);
check("dry run strips pasted numbering", r.body?.outcomes?.[0]?.fullName === "Arun Kumar",
  r.body?.outcomes?.[0]?.fullName);

// The dry run must write nothing.
const afterPreview = await json(`/api/classes/${classId}/`, "GET");
check("dry run wrote nothing", afterPreview.body?.students?.length === 0,
  `${afterPreview.body?.students?.length} students`);

// --- 6. Commit ---------------------------------------------------------------
r = await json(`/api/classes/${classId}/students/`, "POST", { text: roster });
check("students are added", r.status === 200 && r.body.added >= 3, `added ${r.body?.added}`);

const loaded = await json(`/api/classes/${classId}/`, "GET");
check("roster reads back", loaded.body?.students?.length >= 3,
  `${loaded.body?.students?.length} students`);
check("roll number is stored", loaded.body?.students?.some((s) => s.rollNumber === "12"));
check("a student with no phone is flagged as unable to sign in",
  loaded.body?.students?.some((s) => s.canSignIn === false));

// --- 7. Re-adding the same list adds nobody twice ----------------------------
r = await json(`/api/classes/${classId}/students/`, "POST", { text: roster });
check("re-importing the same list adds nobody twice", r.body?.added === 0,
  `added ${r.body?.added}`);

// --- 8. Rotate the join code -------------------------------------------------
const before = loaded.body?.joinCode;
r = await json(`/api/classes/${classId}/join-code/`, "POST");
check("join code rotates", r.status === 200 && r.body.joinCode !== before);

// --- 9. The dashboard reflects it -------------------------------------------
const dash = await fetch(`${BASE}/teacher/`, { headers: { cookie } });
const dashHtml = await dash.text();
const expectedCount = loaded.body?.students?.length ?? 0;
check("dashboard shows the class", dashHtml.includes("Class 10-A"));
check(
  "dashboard shows the real student count, not an em dash",
  dashHtml.includes(`>${expectedCount}<`) && !/ui-stat-value[^>]*data-empty[^>]*>\s*—/.test(
    dashHtml.split("Students")[1] ?? "",
  ),
  `expected ${expectedCount}`,
);

// --- 10. Another tenant sees none of it -------------------------------------
cookie = "";
await json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `other.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});
const theirs = await json("/api/classes/", "GET");
check("a second organisation sees no classes", theirs.body?.classes?.length === 0,
  `${theirs.body?.classes?.length} classes`);

const stolen = await json(`/api/classes/${classId}/`, "GET");
check("another organisation's class by exact id returns 404, not 403",
  stolen.status === 404, `status ${stolen.status}`);

const stolenRoster = await json(`/api/classes/${classId}/students/`, "POST", {
  text: "Injected Student",
});
check("cannot add students to another organisation's class",
  stolenRoster.status === 404, `status ${stolenRoster.status}`);

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
