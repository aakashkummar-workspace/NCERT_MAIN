/**
 * End-to-end smoke check for results, marking and release.
 *
 *   npm run build && npm start
 *   node scripts/smoke-results.mjs
 *
 * The path this covers that no unit test can: a teacher marking a written
 * answer over HTTP and a student, in a different session, seeing their total
 * move — plus the guards that keep the answer key away from a class that is
 * still writing.
 */
import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-results.mjs");
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

/** Stands in for the SMS gateway — see the note in smoke-attempts.mjs. */
async function signInStudent(api, phone) {
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

// --- A paper with one MCQ and one written question -------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Marking Teacher",
  email: `mrk.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Marking Centre ${stamp}`,
  organizationType: "TUITION_CENTRE", boardCode: "CBSE",
});

const picker = await teacher.json("/api/curriculum/picker/");
const authored = picker.body.chapters.find((c) => c.outcomeCount > 0);
const outcome = picker.body.outcomes.find((o) => o.chapterId === authored?.id);
check("a chapter with outcomes is available", Boolean(authored && outcome));

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
    name: "Class 10-B",
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

const phoneOne = `9${String(stamp).slice(-9)}`;
const phoneTwo = `8${String(stamp).slice(-9)}`;
let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: `First Student, ${phoneOne}\nSecond Student, ${phoneTwo}`,
});
check("two students are added with mobiles", r.body?.added === 2, JSON.stringify(r.body));

const mcq = await teacher.json("/api/questions/", "POST", {
  type: "MCQ",
  subjectId: authored.subjectId,
  chapterId: authored.id,
  difficulty: "MEDIUM",
  marks: 2,
  stem: `Which criterion proves similarity from two angles? ${stamp}`,
  options: [
    { key: "A", text: "The AA criterion", isCorrect: true },
    { key: "B", text: "The SSS criterion", isCorrect: false },
    { key: "C", text: "The RHS criterion", isCorrect: false },
  ],
  explanation: "Two equal angles force the third, so the triangles are equiangular.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${mcq.body.id}/`, "POST", { action: "approve" });

const written = await teacher.json("/api/questions/", "POST", {
  type: "SA",
  subjectId: authored.subjectId,
  chapterId: authored.id,
  difficulty: "MEDIUM",
  marks: 3,
  stem: `Explain in your own words why AA is enough. ${stamp}`,
  explanation: "The third angle follows from the first two.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${written.body.id}/`, "POST", { action: "approve" });
check("an objective and a written question are approved",
  Boolean(mcq.body?.id && written.body?.id));

const assessment = await teacher.json("/api/assessments/", "POST", {
  title: `Marked paper ${stamp}`,
  subjectId: authored.subjectId,
  gradeId,
  durationMinutes: 45,
  totalMarks: 5,
});
await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
  questionIds: [mcq.body.id, written.body.id],
});
await teacher.json(`/api/assessments/${assessment.body.id}/publish/`, "POST");

r = await teacher.json("/api/assignments/", "POST", {
  assessmentId: assessment.body.id,
  classId: klass.id,
  opensAt: new Date(Date.now() - 60_000).toISOString(),
  closesAt: new Date(Date.now() + hours(24)).toISOString(),
  maxAttempts: 1,
  // MANUAL, so releasing is a decision this check can make and observe.
  resultsPolicy: "MANUAL",
});
check("the paper is assigned", r.status === 200, `status ${r.status}`);
const assignmentId = r.body?.id;

// --- One student sits it ----------------------------------------------------

const student = session();
check("the student signs in", await signInStudent(student, phoneOne));

r = await student.json("/api/attempts/", "POST", {
  assignmentId,
  clientAttemptId: crypto.randomUUID(),
});
const attemptId = r.body?.attemptId;
check("the attempt starts", r.status === 200, `status ${r.status}`);

const player = await student.json(`/api/attempts/${attemptId}/`);
const mcqPlacement = player.body.questions.find((q) => q.type === "MCQ");
const writtenPlacement = player.body.questions.find((q) => q.type === "SA");

await student.json(`/api/attempts/${attemptId}/answers/`, "PATCH", {
  answers: [
    {
      assessmentQuestionId: mcqPlacement.assessmentQuestionId,
      response: { kind: "choice", keys: ["B"] },
      clientSeq: 1,
    },
    {
      assessmentQuestionId: writtenPlacement.assessmentQuestionId,
      response: { kind: "text", value: "Because the angles match up." },
      clientSeq: 1,
    },
  ],
});
r = await student.json(`/api/attempts/${attemptId}/submit/`, "POST", { reason: "MANUAL" });
check("the paper submits", r.status === 200, `status ${r.status}`);
check("and the score is withheld under a MANUAL policy",
  r.body?.showResult === false, JSON.stringify(r.body));

// --- The teacher's view -----------------------------------------------------

r = await teacher.json(`/api/assignments/${assignmentId}/results/`);
check("the results load", r.status === 200, `status ${r.status}`);
check("both students are expected, not just the one who sat it",
  r.body?.expected === 2, `${r.body?.expected}`);
check("one has submitted", r.body?.submitted === 1, `${r.body?.submitted}`);
check("one paper is awaiting marking", r.body?.awaitingMarking === 1,
  `${r.body?.awaitingMarking}`);
// The MCQ was marked automatically; the written answer was not. An average
// over a half-marked paper would score three unread marks as nought.
check("no class average is reported while nothing is fully marked",
  r.body?.mean === null, `${r.body?.mean}`);
check("and the count of papers behind it is zero, not hidden",
  r.body?.counted === 0, `${r.body?.counted}`);

r = await teacher.json(`/api/assignments/${assignmentId}/results/questions/`);
check("item analysis loads", r.status === 200, `status ${r.status}`);
const mcqItem = r.body?.items?.find((item) => item.type === "MCQ");
const writtenItem = r.body?.items?.find((item) => item.type === "SA");
check("the MCQ shows the class earned none of its marks", mcqItem?.facility === 0,
  `${mcqItem?.facility}`);
check("the chosen distractor is counted",
  mcqItem?.options?.find((o) => o.key === "B")?.chosen === 1);
check("one student is not enough to flag a question",
  mcqItem?.needsAttention === false);
check("the written question reports no figure rather than zero",
  writtenItem?.facility === null && writtenItem?.pending === 1,
  JSON.stringify({ facility: writtenItem?.facility, pending: writtenItem?.pending }));

// --- Marking ----------------------------------------------------------------

r = await teacher.json(`/api/assignments/${assignmentId}/marking/`);
check("the marking queue loads", r.status === 200, `status ${r.status}`);
check("it holds only the written question", r.body?.groups?.length === 1,
  `${r.body?.groups?.length}`);
check("the objective question is not queued for a person",
  r.body?.groups?.[0]?.type === "SA", r.body?.groups?.[0]?.type);
check("with the answer the student wrote",
  r.body?.groups?.[0]?.answers?.[0]?.response === "Because the angles match up.");
const answerId = r.body?.groups?.[0]?.answers?.[0]?.answerId;

r = await teacher.json(`/api/marking/${answerId}/`, "POST", { awardedMarks: 9 });
check("a mark above the question's total is refused, not clamped",
  r.status === 400, `status ${r.status}`);
check("and the refusal names the range",
  /between 0 and 3/.test(r.body?.error?.message ?? ""),
  r.body?.error?.message ?? "");

r = await teacher.json(`/api/marking/${answerId}/`, "POST", {
  awardedMarks: 2,
  feedback: "Right idea, but you never said why the third angle follows.",
});
check("a valid mark is awarded", r.status === 200, `status ${r.status}`);
check("and the paper's total moves with it", r.body?.rawScore === 2,
  `${r.body?.rawScore}`);
check("with nothing left pending", r.body?.pendingMarks === 0,
  `${r.body?.pendingMarks}`);

r = await teacher.json(`/api/assignments/${assignmentId}/results/`);
check("the marked paper now counts", r.body?.counted === 1, `${r.body?.counted}`);
check("and nothing is awaiting marking", r.body?.awaitingMarking === 0);
// One marked paper is not a class. The same refusal the mastery scale makes
// below its evidence threshold, applied here so four cards do not report a
// distribution drawn from a single student.
check("but no distribution is claimed from one paper",
  r.body?.enoughToSummarise === false && r.body?.mean === null,
  JSON.stringify({ enough: r.body?.enoughToSummarise, mean: r.body?.mean }));

// --- The student still cannot see it ----------------------------------------

r = await student.page(`/student/results/${attemptId}/`);
check("the result page renders for the student", r.status === 200, `status ${r.status}`);
check("but withholds the score until the teacher releases it",
  r.html.includes("has not released"), "");

// --- Release ----------------------------------------------------------------

r = await teacher.json(`/api/assignments/${assignmentId}/release/`, "POST");
check("results release", r.status === 200, `status ${r.status}`);
check("with nothing left unmarked to warn about", r.body?.pendingPapers === 0,
  `${r.body?.pendingPapers}`);
const releasedAt = r.body?.releasedAt;

r = await teacher.json(`/api/assignments/${assignmentId}/release/`, "POST");
check("releasing twice is a 200, not an error", r.status === 200, `status ${r.status}`);
check("and returns the first release time", r.body?.releasedAt === releasedAt);
check("saying so rather than pretending it was the first time",
  r.body?.alreadyReleased === true);

r = await student.page(`/student/results/${attemptId}/`);
check("the student now sees the paper title", r.html.includes(`Marked paper ${stamp}`));
check("their marked score", r.html.includes("2</span>"), "");
check("and what the teacher wrote", r.html.includes("you never said why"));
check("with the correct option named", r.html.includes("The AA criterion"));

// --- Another organisation ---------------------------------------------------

const other = session();
await other.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `mrk2.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Centre ${stamp}`,
  organizationType: "SOLO_TEACHER", boardCode: "CBSE",
});

r = await other.json(`/api/assignments/${assignmentId}/results/`);
check("another organisation cannot read these results", r.status === 404,
  `status ${r.status}`);

r = await other.json(`/api/marking/${answerId}/`, "POST", { awardedMarks: 3 });
check("nor mark this answer", r.status === 400 || r.status === 404,
  `status ${r.status}`);

r = await other.json(`/api/assignments/${assignmentId}/release/`, "POST");
check("nor release these results", r.status === 404, `status ${r.status}`);

r = await student.json(`/api/assignments/${assignmentId}/results/`);
check("and a student cannot read the class results", r.status === 403,
  `status ${r.status}`);

r = await student.json(`/api/marking/${answerId}/`, "POST", { awardedMarks: 3 });
check("nor mark their own answer", r.status === 403, `status ${r.status}`);

// --- The pages render -------------------------------------------------------

r = await teacher.page(`/teacher/assignments/${assignmentId}/results/`);
check("the teacher results page renders", r.status === 200, `status ${r.status}`);
check("and names the class average", r.html.includes("Class average"));

r = await teacher.page(`/teacher/assignments/${assignmentId}/marking/`);
check("the marking page renders", r.status === 200, `status ${r.status}`);

r = await teacher.page(`/teacher/assignments/${assignmentId}/`);
check("the assignment page reports who submitted rather than a placeholder",
  r.html.includes("Submitted") && !r.html.includes("arrive with the test player"));

await db.end();
report();
