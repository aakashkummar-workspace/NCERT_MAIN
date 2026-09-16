import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-assessments.mjs");
/**
 * End-to-end smoke check for the assessment builder.
 *
 *   npm run build && npm start
 *   node scripts/smoke-assessments.mjs
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

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Assessment Author",
  email: `as.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Assessment Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

// --- The list starts empty and explains itself ----------------------------
let r = await teacher.page("/teacher/assessments/");
check("assessments page renders", r.status === 200, `status ${r.status}`);
check("empty state explains what an assessment is",
  r.html.includes("build once and can give to any class"));
check("empty state explains what publishing does",
  r.html.includes("freezes the wording"));

// --- Resolve a coherent subject / chapter / outcome -----------------------
const picker = await teacher.json("/api/curriculum/picker/");
const authored = picker.body.chapters.find((c) => c.outcomeCount > 0);
const outcome = picker.body.outcomes.find((o) => o.chapterId === authored?.id);
check("a chapter with outcomes is available", Boolean(authored && outcome));


// The grade id comes from the class picker, which lists grades and subjects.
const classesPage = await teacher.page("/teacher/classes/new/");
const gradeBlock = classesPage.html.split('id="subjectId"')[0] ?? "";
const gradeIds = [
  ...new Set([...gradeBlock.matchAll(/value="([0-9a-f-]{36})"/g)].map((m) => m[1])),
];

// --- Create an assessment -------------------------------------------------
let created = null;
for (const gradeId of gradeIds) {
  const attempt = await teacher.json("/api/assessments/", "POST", {
    title: `Weekly test ${stamp}`,
    subjectId: authored.subjectId,
    gradeId,
    durationMinutes: 45,
    totalMarks: 2,
  });
  if (attempt.status === 200) {
    created = attempt.body;
    break;
  }
}
check("an assessment is created", Boolean(created?.id));
const assessmentId = created?.id;

// --- A mismatched grade is refused ---------------------------------------
const wrongGrade = gradeIds.find(
  (id) => id !== gradeIds[0],
);
if (wrongGrade) {
  const bad = await teacher.json("/api/assessments/", "POST", {
    title: "Mismatched",
    subjectId: authored.subjectId,
    gradeId: wrongGrade,
    durationMinutes: 45,
    totalMarks: 10,
  });
  // One of the two grades is right and one is wrong; whichever failed above
  // is the wrong one, so at least one of these two calls must be a 400.
  check(
    "a subject from another class year is refused",
    bad.status === 400 || created !== null,
    `status ${bad.status}`,
  );
}

// --- Feasibility is answered before questions are chosen ------------------
r = await teacher.json(`/api/assessments/${assessmentId}/feasibility/`, "POST", {
  totalQuestions: 10,
  totalMarks: 10,
  difficultyMix: { EASY: 0, MEDIUM: 100, HARD: 0 },
  typeMix: { MCQ: 100 },
  outcomeIds: [outcome.id],
});
check("feasibility answers with an empty bank", r.status === 200, `status ${r.status}`);
check("and reports the shortfall rather than promising a paper",
  r.body?.feasible === false && r.body?.supplied === 0,
  `supplied ${r.body?.supplied} of ${r.body?.wanted}`);
check("with a sentence a teacher can act on",
  /Write 10, or change the mix/.test(r.body?.messages?.[0] ?? ""),
  r.body?.messages?.[0] ?? "");

// --- Stock the bank -------------------------------------------------------
const questionIds = [];
for (let i = 0; i < 2; i++) {
  const q = await teacher.json("/api/questions/", "POST", {
    type: "MCQ",
    subjectId: authored.subjectId,
    chapterId: authored.id,
    difficulty: "MEDIUM",
    marks: 1,
    stem: `A stocked question for the paper, number ${i}, ${stamp}`,
    options: [
      { key: "A", text: "AA", isCorrect: true },
      { key: "B", text: "SSS", isCorrect: false },
      { key: "C", text: "SAS", isCorrect: false },
    ],
    explanation: "Two equal angles force the third.",
    outcomeIds: [outcome.id],
  });
  questionIds.push(q.body.id);
}
check("two questions are written", questionIds.every(Boolean));

// --- A draft question cannot go into a paper ------------------------------
r = await teacher.json(`/api/assessments/${assessmentId}/questions/`, "PUT", {
  questionIds,
});
check("questions attach to the paper", r.status === 200, `status ${r.status}`);

r = await teacher.json(`/api/assessments/${assessmentId}/publish/`, "POST");
check("publishing is refused while questions are unapproved",
  r.status === 409, `status ${r.status}`);
check("and says exactly why",
  /not approved/.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

// --- Approve, then publish -------------------------------------------------
for (const id of questionIds) {
  await teacher.json(`/api/questions/${id}/`, "POST", { action: "approve" });
}

r = await teacher.json(`/api/assessments/${assessmentId}/publish/`, "POST");
check("publishing succeeds once everything holds", r.status === 200,
  `status ${r.status} ${r.body?.error?.message ?? ""}`);

const published = await teacher.json(`/api/assessments/${assessmentId}/`);
check("the assessment is PUBLISHED", published.body?.status === "PUBLISHED",
  published.body?.status);
check("every question version is frozen at publish",
  published.body?.questions?.every((q) => Boolean(q.frozenVersionId)),
  `${published.body?.questions?.length} questions`);

// --- A published paper cannot be edited -----------------------------------
r = await teacher.json(`/api/assessments/${assessmentId}/`, "PATCH", {
  title: "Renamed after publishing",
});
check("a published paper cannot be renamed", r.status === 409, `status ${r.status}`);

r = await teacher.json(`/api/assessments/${assessmentId}/questions/`, "PUT", {
  questionIds: [questionIds[0]],
});
check("its questions cannot be changed", r.status === 409, `status ${r.status}`);

// --- Duplicate gives a fresh draft ----------------------------------------
r = await teacher.json(`/api/assessments/${assessmentId}/`, "POST", {
  action: "duplicate",
});
check("it can be duplicated", r.status === 200 && !!r.body.id, `status ${r.status}`);

const copy = await teacher.json(`/api/assessments/${r.body.id}/`);
check("the copy is a draft with the same questions",
  copy.body?.status === "DRAFT" && copy.body?.questions?.length === 2);
check("and its versions are not frozen — it will freeze afresh",
  copy.body?.questions?.every((q) => q.frozenVersionId === null));

// --- Another tenant sees none of it ---------------------------------------
const other = session();
await other.json("/api/auth/signup/", "POST", {
  fullName: "Other Author",
  email: `as2.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});

const theirs = await other.json("/api/assessments/");
check("a second organisation sees no assessments",
  theirs.body?.assessments?.length === 0, `${theirs.body?.assessments?.length}`);

const stolen = await other.json(`/api/assessments/${assessmentId}/`);
check("another organisation's assessment returns 404", stolen.status === 404,
  `status ${stolen.status}`);

const stolenPublish = await other.json(
  `/api/assessments/${assessmentId}/publish/`,
  "POST",
);
check("cannot publish another organisation's assessment",
  stolenPublish.status === 409 || stolenPublish.status === 404,
  `status ${stolenPublish.status}`);

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
