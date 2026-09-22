import "dotenv/config";
import { randomUUID } from "node:crypto";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-paper-tools.mjs");
/**
 * End-to-end smoke check for the paper tools: printed sign-in cards, a paper
 * sat on paper and recorded, the answer-sheet and recording pages, and the
 * refusals on answer photos and drafted marks.
 *
 *   npm run build && npm start
 *   node scripts/smoke-paper-tools.mjs
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
        headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async page(path) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
      return { status: res.status, html: await res.text() };
    },
  };
}

// --- A teacher, a class with no phones in it --------------------------------
const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Paper Tools Teacher",
  email: `paper.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Paper Tools School ${stamp}`,
  organizationType: "SCHOOL",
  boardCode: "CBSE",
});

const picker = await teacher.json("/api/curriculum/picker/");
const authored = picker.body.chapters.find((c) => c.outcomeCount > 0);
const outcome = picker.body.outcomes.find((o) => o.chapterId === authored?.id);
check("a chapter with outcomes is available", Boolean(authored && outcome));

const newClass = await teacher.page("/teacher/classes/new/");
const gradeIds = [
  ...new Set(
    [...(newClass.html.split('id="subjectId"')[0] ?? "").matchAll(/value="([0-9a-f-]{36})"/g)].map(
      (m) => m[1],
    ),
  ),
];
let klass = null;
let gradeId = null;
for (const candidate of gradeIds) {
  const attempt = await teacher.json("/api/classes/", "POST", {
    name: "Class 9-B",
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

// No phone numbers at all: until cards, nobody here could sign in.
let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: "Kavya Iyer\nRohan Das",
});
check("two students with no phone are added", r.body?.added === 2, `added ${r.body?.added}`);

const classPage = await teacher.page(`/teacher/classes/${klass.id}/`);
check("the class page offers sign-in cards", /Sign-in cards/.test(classPage.html));
check(
  "and says the students cannot sign in yet, naming both ways in",
  /no mobile number and no sign-in card/.test(classPage.html),
);

// --- Cards ------------------------------------------------------------------
const cardsPage = await teacher.page(`/teacher/classes/${klass.id}/cards/`);
check("the cards page renders", cardsPage.status === 200, `status ${cardsPage.status}`);
check("and shows no code before one is issued", !/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/.test(cardsPage.html));

r = await teacher.json(`/api/classes/${klass.id}/login-cards/`, "POST", { scope: "missing" });
check("cards are issued for everyone without one", r.status === 200 && r.body?.cards?.length === 2,
  `status ${r.status}`);
const firstCards = r.body?.cards ?? [];
check("each code is three groups of four", firstCards.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c.code)));

r = await teacher.json(`/api/classes/${klass.id}/login-cards/`, "POST", { scope: "missing" });
check("issuing 'missing' again prints nothing", r.status === 409, `status ${r.status}`);

const status = await teacher.json(`/api/classes/${klass.id}/login-cards/`);
check("the status lists hints, never codes",
  status.body?.students?.every((row) => row.hint && row.hint.length === 4) &&
    !JSON.stringify(status.body).includes(firstCards[0]?.code ?? "--"));

const cardPage = await session().page("/signin/card/");
check("the card sign-in page renders for anybody", cardPage.status === 200 && /Card code/.test(cardPage.html));

const kavya = session();
r = await kavya.json("/api/auth/card/", "POST", { code: firstCards[0].code.toLowerCase() });
check("a student signs in with their card, in any case", r.status === 200 && r.body?.role === "STUDENT",
  `status ${r.status}`);
const home = await kavya.page("/student/");
check("and reaches their home", home.status === 200, `status ${home.status}`);

r = await session().json("/api/auth/card/", "POST", { code: "ZZZZ-ZZZZ-ZZZZ" });
check("a wrong code is refused", r.status === 401, `status ${r.status}`);

r = await kavya.json(`/api/classes/${klass.id}/login-cards/`, "POST", { scope: "all" });
check("a student cannot print cards", r.status === 403 || r.status === 404, `status ${r.status}`);

r = await teacher.json(`/api/classes/${klass.id}/login-cards/`, "POST", {
  scope: "all",
  studentIds: [firstCards[1].studentUserId],
});
const replaced = r.body?.cards?.[0]?.code;
r = await session().json("/api/auth/card/", "POST", { code: firstCards[1].code });
check("a replaced card stops working", r.status === 401, `status ${r.status}`);
r = await session().json("/api/auth/card/", "POST", { code: replaced });
check("and its replacement works", r.status === 200, `status ${r.status}`);

// --- A paper sat on paper -----------------------------------------------------
const question = await teacher.json("/api/questions/", "POST", {
  type: "MCQ",
  subjectId: authored.subjectId,
  chapterId: authored.id,
  difficulty: "MEDIUM",
  marks: 1,
  stem: `A question sat on paper ${stamp}`,
  options: [
    { key: "A", text: "Right", isCorrect: true },
    { key: "B", text: "Wrong", isCorrect: false },
  ],
  explanation: "Because.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${question.body.id}/`, "POST", { action: "approve" });
const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Paper test ${stamp}`,
  subjectId: authored.subjectId,
  gradeId,
  durationMinutes: 30,
  totalMarks: 1,
});
await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
  questionIds: [question.body.id],
});
await teacher.json(`/api/assessments/${assessment.body.id}/publish/`, "POST");

r = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  // Last week's test, recorded today: a paper sitting may be in the past.
  opensAt: new Date(Date.now() - hours(170)).toISOString(),
  closesAt: new Date(Date.now() - hours(168)).toISOString(),
  maxAttempts: 1,
  resultsPolicy: "IMMEDIATE",
  deliveryMode: "PAPER",
});
check("a paper sat last week can be assigned", r.status === 200, JSON.stringify(r.body?.error ?? ""));
const assignmentId = r.body?.id;

r = await kavya.json("/api/attempts/", "POST", { assignmentId, clientAttemptId: randomUUID() });
check("a student cannot start a paper sat on paper", r.status !== 200, `status ${r.status}`);

const sheet = await teacher.json(`/api/assignments/${assignmentId}/paper/`);
check("the recording sheet lists the class", sheet.status === 200 && sheet.body?.students?.length === 2,
  `status ${sheet.status}`);
check("and never carries which option is right", !/isCorrect|answerKey/.test(JSON.stringify(sheet.body)));

const kavyaId = firstCards[0].studentUserId;
r = await teacher.json(`/api/assignments/${assignmentId}/paper/`, "POST", {
  studentUserId: kavyaId,
  entries: [
    { assessmentQuestionId: sheet.body.questions[0].assessmentQuestionId, kind: "choice", keys: ["A"] },
  ],
});
check("a paper sitting is recorded and marked against the key", r.status === 200 && r.body?.rawScore === 1,
  JSON.stringify(r.body));

r = await teacher.json(`/api/assignments/${assignmentId}/paper/`, "POST", {
  studentUserId: kavyaId,
  entries: [
    { assessmentQuestionId: sheet.body.questions[0].assessmentQuestionId, kind: "choice", keys: ["B"] },
  ],
});
check("recording again corrects rather than adding a sitting",
  r.status === 200 && r.body?.created === false && r.body?.rawScore === 0, JSON.stringify(r.body));

r = await teacher.json(`/api/assignments/${assignmentId}/paper/`, "POST", {
  studentUserId: kavyaId,
  entries: [
    { assessmentQuestionId: sheet.body.questions[0].assessmentQuestionId, kind: "choice", keys: ["Q"] },
  ],
});
check("an option the question does not have is refused", r.status === 400, `status ${r.status}`);

const entryPage = await teacher.page(`/teacher/assignments/${assignmentId}/paper/`);
check("the recording page renders", entryPage.status === 200 && /Record paper answers/.test(entryPage.html));
const sheetsPage = await teacher.page(`/teacher/assignments/${assignmentId}/sheets/`);
check("the answer sheets render, one per student",
  sheetsPage.status === 200 && (sheetsPage.html.match(/Answer sheet for /g) ?? []).length >= 2);

// --- Photos and drafts refuse strangers ---------------------------------------
r = await kavya.json(`/api/answer-images/${randomUUID()}/`);
check("an answer photo that is not yours is a 404", r.status === 404, `status ${r.status}`);
r = await kavya.json(`/api/marking/${randomUUID()}/draft/`, "POST");
check("a student cannot ask for drafted marks", r.status === 403 || r.status === 404, `status ${r.status}`);
r = await teacher.json(`/api/marking/${randomUUID()}/draft/`, "POST");
check("a draft for an answer that does not exist is a 404", r.status === 404, `status ${r.status}`);

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
