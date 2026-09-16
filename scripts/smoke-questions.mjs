import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-questions.mjs");
/**
 * End-to-end smoke check for the question bank.
 *
 *   npm run build && npm start
 *   node scripts/smoke-questions.mjs
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
  fullName: "Question Author",
  email: `qa.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Question Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

// --- The bank starts empty, and says something useful --------------------
let r = await teacher.page("/teacher/questions/");
check("bank page renders", r.status === 200, `status ${r.status}`);
check(
  "empty bank explains why questions are worth adding",
  r.html.includes("reused in every assessment"),
);
check("empty bank offers an action", r.html.includes("Write your first question"));

// --- Resolve a coherent subject / chapter / outcome triple ---------------
r = await teacher.page("/teacher/questions/new/");
check("editor renders", r.status === 200, `status ${r.status}`);

const picker = await teacher.json("/api/curriculum/picker/");
check("the picker offers chapters", picker.body?.chapters?.length > 10,
  `${picker.body?.chapters?.length}`);
check("the picker offers learning outcomes", picker.body?.outcomes?.length > 0,
  `${picker.body?.outcomes?.length}`);

// The worked example is the one chapter with outcomes authored against it.
const authored = picker.body.chapters.find((c) => c.outcomeCount > 0);
check("a chapter with outcomes exists to file against", Boolean(authored),
  authored?.label ?? "none");

const outcome = picker.body.outcomes.find((o) => o.chapterId === authored?.id);
const { body: apiList } = await teacher.json("/api/questions/");
check("bank API returns an empty list", apiList?.questions?.length === 0);

const good = {
  type: "MCQ",
  subjectId: authored.subjectId,
  chapterId: authored.id,
  difficulty: "MEDIUM",
  marks: 1,
  stem: `Which similarity criterion needs two pairs of equal angles? ${stamp}`,
  options: [
    { key: "A", text: "AA", isCorrect: true },
    { key: "B", text: "SSS", isCorrect: false },
    { key: "C", text: "SAS", isCorrect: false },
  ],
  explanation: "Two equal angles force the third.",
  outcomeIds: outcome ? [outcome.id] : [],
};

// --- A mis-filed question is refused before it can corrupt mastery -------
const wrongSubject = picker.body.chapters.find(
  (c) => c.subjectId !== authored.subjectId,
);
r = await teacher.json("/api/questions/", "POST", {
  ...good,
  stem: `Filed under the wrong subject ${stamp}`,
  subjectId: wrongSubject.subjectId,
});
check(
  "a chapter from another subject is refused",
  r.status === 400,
  `status ${r.status}`,
);

r = await teacher.json("/api/questions/", "POST", good);
check("a valid question saves", r.status === 200 && !!r.body.id, `status ${r.status}`);
const questionId = r.body?.id;

// --- The rules that protect a student ------------------------------------
r = await teacher.json("/api/questions/", "POST", {
  ...good,
  stem: `Two correct answers on a one-answer question ${stamp}`,
  options: [
    { key: "A", text: "AA", isCorrect: true },
    { key: "B", text: "SSS", isCorrect: true },
  ],
});
check(
  "two correct options on a single-answer question is refused",
  r.status === 400,
  `status ${r.status}`,
);

r = await teacher.json("/api/questions/", "POST", good);
check("an exact duplicate is refused", r.status === 409, `status ${r.status}`);

// --- Approval -------------------------------------------------------------
r = await teacher.json(`/api/questions/${questionId}/`, "POST", { action: "approve" });
const approvable = Boolean(outcome);
check(
  approvable
    ? "a question linked to an outcome can be approved"
    : "a question with no outcome cannot be approved",
  approvable ? r.status === 200 : r.status === 409,
  `status ${r.status}`,
);

// --- Versioning -----------------------------------------------------------
if (approvable) {
  r = await teacher.json(`/api/questions/${questionId}/`, "PUT", {
    ...good,
    stem: `Reworded after approval, which must create version two ${stamp}`,
  });
  check("editing an approved question creates version 2", r.body?.version === 2,
    `version ${r.body?.version}`);

  const detail = await teacher.json(`/api/questions/${questionId}/`);
  check(
    "and returns it to draft, because the approval was for the old wording",
    detail.body?.status === "DRAFT",
    detail.body?.status,
  );
  check("the earlier version is kept", detail.body?.versionCount === 2,
    `${detail.body?.versionCount} versions`);
}

// --- Rejection needs a reason ---------------------------------------------
r = await teacher.json(`/api/questions/${questionId}/`, "POST", { action: "reject" });
check("rejecting without a reason is refused", r.status === 400, `status ${r.status}`);

r = await teacher.json(`/api/questions/${questionId}/`, "POST", {
  action: "reject",
  reason: "The distractors are implausible.",
});
check("rejecting with a reason works", r.status === 200, `status ${r.status}`);

const rejected = await teacher.json(`/api/questions/${questionId}/`);
check("the reason survives for whoever wrote it",
  /distractors/.test(rejected.body?.rejectionReason ?? ""));

// --- Another tenant sees none of it ---------------------------------------
const other = session();
await other.json("/api/auth/signup/", "POST", {
  fullName: "Other Author",
  email: `qb.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});

const theirs = await other.json("/api/questions/");
check("a second organisation sees an empty bank", theirs.body?.questions?.length === 0,
  `${theirs.body?.questions?.length}`);

const stolen = await other.json(`/api/questions/${questionId}/`);
check("another organisation's question by exact id returns 404",
  stolen.status === 404, `status ${stolen.status}`);

const stolenApprove = await other.json(`/api/questions/${questionId}/`, "POST", {
  action: "approve",
});
check("cannot approve another organisation's question",
  stolenApprove.status === 404, `status ${stolenApprove.status}`);

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
