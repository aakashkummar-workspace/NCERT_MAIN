import "dotenv/config";
import { assertLocalDatabase } from "./lib/local-database.mjs";

assertLocalDatabase("smoke-series.mjs");
/**
 * End-to-end smoke check for exam series.
 *
 *   npm run build && npm start
 *   node scripts/smoke-series.mjs
 *
 * What needs a real HTTP round trip here:
 *
 *   1. **No status column.** Three papers in three window states, and the
 *      series reports all three from their own stamps — then moves when the
 *      clock does, with nothing written.
 *   2. **Withdrawing the label does not cancel the exams.** The one thing
 *      this feature must never do.
 *   3. **No total anywhere on the screen.** A series looks like a report card,
 *      which is exactly why it must not carry an aggregate.
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

// --- A school with a published paper ---------------------------------------

const teacher = session();
await teacher.json("/api/auth/signup/", "POST", {
  fullName: "Series Teacher",
  email: `srs.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Series Centre ${stamp}`,
  organizationType: "TUITION_CENTRE",
  boardCode: "CBSE",
});

const picker = await teacher.json("/api/curriculum/picker/");
const authored = picker.body.chapters.find((c) => c.outcomeCount > 0);
const outcome = picker.body.outcomes.find((o) => o.chapterId === authored?.id);
check("a chapter with outcomes is available", Boolean(authored && outcome));

const classesPage = await teacher.page("/teacher/classes/new/");
const gradeIds = [
  ...new Set(
    [
      ...(classesPage.html.split('id="subjectId"')[0] ?? "").matchAll(
        /value="([0-9a-f-]{36})"/g,
      ),
    ].map((m) => m[1]),
  ),
];

let klass = null;
let gradeId = null;
for (const candidate of gradeIds) {
  const attempt = await teacher.json("/api/classes/", "POST", {
    name: "Class 10-S",
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

let r = await teacher.json(`/api/classes/${klass.id}/students/`, "POST", {
  text: `Series Student, 97${String(stamp).slice(-8)}`,
});
check("a student is added", r.body?.added === 1, JSON.stringify(r.body));

const question = await teacher.json("/api/questions/", "POST", {
  type: "MCQ",
  subjectId: authored.subjectId,
  chapterId: authored.id,
  difficulty: "MEDIUM",
  marks: 1,
  stem: `A question for the series paper ${stamp}`,
  options: [
    { key: "A", text: "The right one", isCorrect: true },
    { key: "B", text: "The wrong one", isCorrect: false },
  ],
  explanation: "Because the definition says so.",
  outcomeIds: [outcome.id],
});
await teacher.json(`/api/questions/${question.body.id}/`, "POST", { action: "approve" });

/** A published paper assigned to the class, with the window given. */
async function paper(title, opensAt, closesAt) {
  const assessment = await teacher.json("/api/assessments/", "POST", {
    title,
    subjectId: authored.subjectId,
    gradeId,
    durationMinutes: 30,
    totalMarks: 1,
  });
  await teacher.json(`/api/assessments/${assessment.body.id}/questions/`, "PUT", {
    questionIds: [question.body.id],
  });
  await teacher.json(`/api/assessments/${assessment.body.id}/publish/`, "POST");
  const assigned = await teacher.json("/api/assignments/", "POST", {
    assessmentId: assessment.body.id,
    classId: klass.id,
    opensAt: opensAt.toISOString(),
    closesAt: closesAt.toISOString(),
    maxAttempts: 1,
    resultsPolicy: "AFTER_CLOSE",
  });
  return assigned.body?.id;
}

const openNow = await paper(
  `Series paper open ${stamp}`,
  new Date(Date.now() - hours(1)),
  new Date(Date.now() + hours(2)),
);
const later = await paper(
  `Series paper later ${stamp}`,
  new Date(Date.now() + hours(24)),
  new Date(Date.now() + hours(48)),
);
check("two papers are assigned", Boolean(openNow && later));

// --- Naming one -------------------------------------------------------------

r = await teacher.json("/api/series/", "POST", {
  name: "Half-Yearly",
  academicYear: "2026-27",
  note: "All Class 10 subjects.",
});
check("a series can be named", r.status === 201, `status ${r.status}`);
const seriesId = r.body?.id;

r = await teacher.json("/api/series/", "POST", {
  name: "half yearly",
  academicYear: "2026-27",
});
// Indistinguishable on every screen that lists them, and whichever a paper
// lands in would be a coin toss.
check("a second series with the same name in the same year is refused",
  r.status === 409, `status ${r.status}`);
check("and the refusal names the one that already exists",
  /Half-Yearly/.test(r.body?.error?.message ?? ""), r.body?.error?.message);

r = await teacher.json("/api/series/", "POST", {
  name: "Half-Yearly",
  academicYear: "2026",
});
check("an academic year that is not one is refused", r.status === 400,
  `status ${r.status}`);

// --- It holds papers, and its state is derived ------------------------------

r = await teacher.json("/api/series/", "GET");
let row = (r.body?.series ?? []).find((s) => s.id === seriesId);
// A named series holding nothing is where every series starts.
check("a new series holds nothing, and says so", row?.status === "EMPTY",
  row?.status);

r = await teacher.json(`/api/series/${seriesId}/papers/`, "POST", {
  assignmentId: openNow,
});
check("a paper can be put in it", r.status === 201, `status ${r.status}`);
await teacher.json(`/api/series/${seriesId}/papers/`, "POST", {
  assignmentId: later,
});

r = await teacher.json("/api/series/", "GET");
row = (r.body?.series ?? []).find((s) => s.id === seriesId);
// One paper open, one still to come: under way. Derived from the two windows
// and the clock, with nothing stored.
check("with a paper open it is under way", row?.status === "RUNNING", row?.status);
check("counting the papers it holds", row?.papers === 2, String(row?.papers));
check("and taking its dates from their windows", Boolean(row?.from && row?.to), "");

// --- A paper belongs to one series -----------------------------------------

r = await teacher.json("/api/series/", "POST", {
  name: "Pre-Boards",
  academicYear: "2026-27",
});
const second = r.body?.id;
r = await teacher.json(`/api/series/${second}/papers/`, "POST", {
  assignmentId: openNow,
});
// Never a silent move: a paper that quietly left the half-yearly is a paper
// missing from a report nobody will re-read.
check("a paper cannot be moved into a second series", r.status === 409,
  `status ${r.status}`);
check("and is told to take it out of the first",
  /another series/i.test(r.body?.error?.message ?? ""), r.body?.error?.message);

// --- On the page ------------------------------------------------------------

let page = await teacher.page("/teacher/series/");
check("the series list renders", page.status === 200, `status ${page.status}`);
check("naming the series", page.html.includes("Half-Yearly"), "");
check("and saying what it is doing", /Under way/i.test(page.html), "");

page = await teacher.page(`/teacher/series/${seriesId}/`);
check("the series page renders", page.status === 200, `status ${page.status}`);
check("listing its papers", page.html.includes(`Series paper open ${stamp}`), "");
check("with each paper's own window state",
  /Open now/i.test(page.html) && /Not open yet/i.test(page.html), "");
// The composite this product refuses everywhere else. A series looks exactly
// like a report card, which is why the absence is checked rather than assumed.
check("and no total across the series",
  /carries no total/i.test(page.html), "");
check("stated as marks per paper instead",
  /of 1 sat|sat/.test(page.html), "");

// The paper says which event it belongs to, where somebody wondering is
// already looking.
page = await teacher.page(`/teacher/assignments/${openNow}/`);
check("the paper names the series it is in", page.html.includes("Half-Yearly"), "");
check("and links back to it", page.html.includes(`/teacher/series/${seriesId}`), "");

// --- Taking a paper out leaves the paper alone ------------------------------

r = await teacher.json(`/api/series/${seriesId}/papers/`, "DELETE", {
  assignmentId: later,
});
check("a paper can be taken out", r.status === 200, `status ${r.status}`);

r = await teacher.json(`/api/assignments/?classId=${klass.id}`);
const stillThere = (r.body?.assignments ?? []).find((a) => a.id === later);
check("and the paper itself is untouched",
  stillThere?.status === "SCHEDULED", stillThere?.status);

// --- Withdrawing the label does not cancel the exams ------------------------

r = await teacher.json(`/api/series/${seriesId}/`, "DELETE");
check("a series can be withdrawn", r.status === 200, `status ${r.status}`);
check("and says how many papers stopped being grouped",
  r.body?.papers === 1, String(r.body?.papers));

r = await teacher.json(`/api/assignments/?classId=${klass.id}`);
const survivor = (r.body?.assignments ?? []).find((a) => a.id === openNow);
// The one thing this must never do.
check("the papers are NOT cancelled", survivor?.status === "OPEN", survivor?.status);

r = await teacher.json("/api/series/", "GET");
check("a withdrawn series leaves the working list",
  !(r.body?.series ?? []).some((s) => s.id === seriesId), "");

r = await teacher.json(`/api/series/${seriesId}/`, "DELETE");
// A stamp, not a delete, so withdrawing twice is not a second withdrawal.
check("withdrawing it twice is not a second withdrawal", r.status === 404,
  `status ${r.status}`);

// --- Scope ------------------------------------------------------------------

r = await fetch(`${BASE}/api/series/`);
check("an anonymous visitor cannot list series", r.status === 401,
  `status ${r.status}`);

page = await fetch(`${BASE}/teacher/series/`, { redirect: "manual" });
check("and is sent to sign in rather than shown the page",
  page.status === 307 || page.status === 308, `status ${page.status}`);

const stranger = session();
await stranger.json("/api/auth/signup/", "POST", {
  fullName: "Other Teacher",
  email: `srs.other.${stamp}@example.test`,
  password: "a-long-enough-password",
  organizationName: `Other Series ${stamp}`,
  organizationType: "TUITION_CENTRE",
  boardCode: "CBSE",
});
r = await stranger.json("/api/series/", "GET");
check("another organisation sees none of it",
  !(r.body?.series ?? []).some((s) => s.id === second), "");
r = await stranger.json(`/api/series/${second}/`, "PATCH", { name: "Mine now" });
check("and cannot rename it", r.status === 404, `status ${r.status}`);
r = await stranger.json(`/api/series/${second}/papers/`, "POST", {
  assignmentId: openNow,
});
check("nor put its papers in their own", r.status === 404, `status ${r.status}`);
page = await stranger.page(`/teacher/series/${seriesId}/`);
check("and gets a 404 on the page", page.status === 404, `status ${page.status}`);

report();
