import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-assignments.mjs");
/**
 * End-to-end smoke check for assignment.
 *
 *   npm run build && npm start
 *   node scripts/smoke-assignments.mjs
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
    // The whole Response: a download is judged by its headers as much as by
    // its body.
    async raw(path) {
      return fetch(`${BASE}${path}`, { headers: { cookie } });
    },
  };
}

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Assigning Teacher",
  email: `asg.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Assign Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

// --- Curriculum, class, roster --------------------------------------------
const picker = await teacher.json("/api/curriculum/picker/");
const authored = picker.body.chapters.find((c) => c.outcomeCount > 0);
const outcome = picker.body.outcomes.find((o) => o.chapterId === authored?.id);
check("a chapter with outcomes is available", Boolean(authored && outcome));

const classesPage = await teacher.page("/teacher/classes/new/");
const gradeIds = [
  ...new Set(
    [...(classesPage.html.split('id="subjectId"')[0] ?? "").matchAll(
      /value="([0-9a-f-]{36})"/g,
    )].map((m) => m[1]),
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
check("a class is created for the subject", Boolean(klass?.id));

let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: `Arun Kumar, 98${String(stamp).slice(-8)}\nMeera Nair`,
});
check("students are added", r.body?.added === 2, `added ${r.body?.added}`);

// --- A published paper ----------------------------------------------------
const question = await teacher.json("/api/questions/", "POST", {
  type: "MCQ",
  subjectId: authored.subjectId,
  chapterId: authored.id,
  difficulty: "MEDIUM",
  marks: 1,
  stem: `A question for the assigned paper ${stamp}`,
  options: [
    { key: "A", text: "AA", isCorrect: true },
    { key: "B", text: "SSS", isCorrect: false },
  ],
  explanation: "Two equal angles force the third.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${question.body.id}/`, "POST", {
  action: "approve",
});

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Assigned paper ${stamp}`,
  subjectId: authored.subjectId,
  gradeId,
  durationMinutes: 45,
  totalMarks: 1,
});
await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
  questionIds: [question.body.id],
});

// --- A draft paper cannot be assigned -------------------------------------
const window = {
  opensAt: new Date(Date.now() + hours(1)).toISOString(),
  closesAt: new Date(Date.now() + hours(25)).toISOString(),
};

r = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  ...window,
  maxAttempts: 1,
  resultsPolicy: "AFTER_CLOSE",
});
check("a draft paper cannot be assigned", r.status === 400, `status ${r.status}`);
check("and the refusal explains why publishing matters",
  /freezes the question wording/.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

await teacher.json(`/api/assessments/${assessment.body.id}/publish/`, "POST");

// --- Window validation -----------------------------------------------------
r = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  opensAt: window.opensAt,
  // 30 minutes for a 45-minute paper.
  closesAt: new Date(Date.now() + hours(1) + 30 * 60_000).toISOString(),
  maxAttempts: 1,
  resultsPolicy: "AFTER_CLOSE",
});
check("a window shorter than the paper is refused", r.status === 400,
  `status ${r.status}`);
check("and says nobody could finish it",
  /Nobody could finish it/.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

r = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  opensAt: new Date(Date.now() - hours(48)).toISOString(),
  closesAt: new Date(Date.now() - hours(24)).toISOString(),
  maxAttempts: 1,
  resultsPolicy: "AFTER_CLOSE",
});
check("a window that already closed is refused", r.status === 400,
  `status ${r.status}`);

// --- Assign ----------------------------------------------------------------
r = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  ...window,
  maxAttempts: 1,
  resultsPolicy: "AFTER_CLOSE",
});
check("a published paper assigns", r.status === 200 && !!r.body.id,
  `status ${r.status} ${r.body?.error?.message ?? ""}`);
const assignmentId = r.body?.id;

const detail = await teacher.json(`/api/assignments/${assignmentId}/`);
check("its status is SCHEDULED, derived from the window",
  detail.body?.status === "SCHEDULED", detail.body?.status);
check("it goes to the whole class", detail.body?.wholeClass === true);
check("both students are listed", detail.body?.students?.length === 2,
  `${detail.body?.students?.length}`);
check("a student with no mobile is flagged as unable to sit it",
  detail.body?.students?.some((s) => s.canSignIn === false));

// --- An open window is derived, not written --------------------------------
r = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  opensAt: new Date(Date.now() - 60_000).toISOString(),
  closesAt: new Date(Date.now() + hours(24)).toISOString(),
  maxAttempts: 1,
  resultsPolicy: "AFTER_CLOSE",
});
const openOne = await teacher.json(`/api/assignments/${r.body.id}/`);
check("an assignment whose window has begun reads as OPEN with no job having run",
  openOne.body?.status === "OPEN", openOne.body?.status);

// --- Editing the window -----------------------------------------------------
const extended = new Date(Date.now() + hours(72)).toISOString();
r = await teacher.json(`/api/assignments/${assignmentId}/`, "PATCH", {
  closesAt: extended,
});
check("the window can be extended", r.status === 200, `status ${r.status}`);

r = await teacher.json(`/api/assignments/${assignmentId}/`, "PATCH", {
  closesAt: new Date(Date.now() + hours(1) + 60_000).toISOString(),
});
check("but not shortened below the paper duration", r.status === 400,
  `status ${r.status}`);

// --- Cancelling -------------------------------------------------------------
r = await teacher.json(`/api/assignments/${assignmentId}/`, "DELETE");
check("it can be cancelled", r.status === 200, `status ${r.status}`);

const cancelled = await teacher.json(`/api/assignments/${assignmentId}/`);
check("cancelling overrides the clock", cancelled.body?.status === "CANCELLED",
  cancelled.body?.status);

r = await teacher.json(`/api/assignments/${assignmentId}/`, "PATCH", {
  maxAttempts: 2,
});
check("a cancelled assignment cannot be edited", r.status === 400,
  `status ${r.status}`);

// --- The pages render -------------------------------------------------------
r = await teacher.page(`/teacher/assignments/${assignmentId}/`);
check("the assignment page renders", r.status === 200, `status ${r.status}`);
check("it says students have not started rather than leaving it blank",
  r.html.includes("Not started") || r.html.includes("No mobile"));

r = await teacher.page(`/teacher/assessments/${assessment.body.id}/`);
check("the assessment page shows its assignments", r.html.includes("Class 10-A"));

// --- Another tenant ---------------------------------------------------------
const other = session();
await other.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `asg2.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});

const theirs = await other.json("/api/assignments/");
check("a second organisation sees no assignments",
  theirs.body?.assignments?.length === 0, `${theirs.body?.assignments?.length}`);

const stolen = await other.json(`/api/assignments/${assignmentId}/`);
check("another organisation's assignment returns 404", stolen.status === 404,
  `status ${stolen.status}`);

const stolenCancel = await other.json(`/api/assignments/${assignmentId}/`, "DELETE");
check("cannot cancel another organisation's assignment",
  stolenCancel.status === 404, `status ${stolenCancel.status}`);

// --- The live view (IMPLEMENTATION_PLAN.md §7.1) ------------------------------

r = await teacher.page(`/teacher/assignments/${assignmentId}/monitor/`);
check("the live view opens for the teacher", r.status === 200, `status ${r.status}`);
check("and names the four states a sitting can be in",
  ["Writing", "Not started", "Handed in", "Time ran out"].every((label) =>
    r.html.includes(label)));
// A fact about the PAGE, not about the database: in this world nobody has sat
// the paper yet, so asserting that some row reads "3 of 4 answered" would be a
// check on the data. What must always hold is that the page states the rule.
check("and says why marks are not shown during a paper",
  /Marks are not shown while a paper is being written/.test(r.html));
check("and carries no score at all",
  !/rawScore|percentage|awardedMarks/.test(r.html));

const stolenLive = await other.page(`/teacher/assignments/${assignmentId}/monitor/`);
check("another organisation's live view is 404", stolenLive.status === 404,
  `status ${stolenLive.status}`);

// --- Marks export (IMPLEMENTATION_PLAN.md §7.2) -------------------------------

const exportRes = await teacher.raw(`/api/results/${assignmentId}/export/`);
const exportBody = await exportRes.text();
check("the marks export downloads", exportRes.status === 200, `status ${exportRes.status}`);
check("as a CSV",
  (exportRes.headers.get("content-type") ?? "").startsWith("text/csv"),
  exportRes.headers.get("content-type") ?? "");
check("as an attachment with a findable filename",
  /attachment; filename=".*\.csv"/.test(exportRes.headers.get("content-disposition") ?? ""),
  exportRes.headers.get("content-disposition") ?? "");
// A marks file is a snapshot of a moment; a cached copy is a wrong answer to
// "what does the register say now".
check("and is not cached", (exportRes.headers.get("cache-control") ?? "").includes("no-store"));
check("with the columns an office needs",
  ["roll_number", "student", "marks", "out_of", "fully_marked"].every((column) =>
    exportBody.includes(column)));
check("and no mastery figure anywhere in it",
  !/mastery|estimate|band/i.test(exportBody));

const stolenExport = await other.raw(`/api/results/${assignmentId}/export/`);
check("another organisation cannot download it", stolenExport.status === 404,
  `status ${stolenExport.status}`);

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
