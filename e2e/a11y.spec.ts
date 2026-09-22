import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import "dotenv/config";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import pg from "pg";
import { expectNoViolations } from "./support/axe";
import {
  closeDb,
  grantFullPlan,
  makeWorld,
  phoneFor,
  signInStudent,
  signUpTeacher,
  stamp,
} from "./support/harness";

/**
 * The accessibility suite.
 *
 * DESIGN_SYSTEM.md §9/§14 and TESTING.md §7 have promised "axe-core on every
 * page, zero violations" and "every interactive element reachable and operable
 * by keyboard; visible focus always" for months. Nothing had ever run them.
 * This is the first time the claim is measured.
 *
 * ---------------------------------------------------------------------------
 * One route, one test
 * ---------------------------------------------------------------------------
 * A single test that walked fifty pages would stop at the first violation and
 * report one page's problem as the whole product's. Every route is its own
 * test case with its path in the title, so the failure list IS the fix list.
 *
 * Nothing is disabled to make this pass. `e2e/support/axe.ts` keeps an empty
 * DISABLED array and it stays empty — see the note in that file.
 *
 * ---------------------------------------------------------------------------
 * The world is built once and cached on disk
 * ---------------------------------------------------------------------------
 * Playwright discards a worker process after a failing test, which re-runs
 * `beforeAll`. On a suite whose whole purpose is to find failures that would
 * mean rebuilding an organisation, a roster, three papers and four sessions
 * forty times over. So the ids and the storage states are written to a
 * temporary file and reused while they are fresh — which also makes a re-run
 * after a fix take seconds rather than minutes.
 *
 * Every run still builds its OWN organisation. Nothing here reads seed state
 * beyond the curriculum, which is public record and read-only to a tenant.
 */

/**
 * No traces, no screenshots, from this file.
 *
 * The contexts here are shared across tests so the world is built once, and
 * per-test trace recording on a shared context races itself — two tests'
 * recordings copying the same artifact, which surfaced as ENOENT inside
 * `afterAll` and took the rest of the file down with it. Nothing is lost: an
 * axe failure carries the rule, the impact and the selector in its message,
 * which is the whole of what a trace would be opened for here.
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Not under `test-results/`: Playwright owns that directory and clears it, and
 * a cache that the runner deletes underneath a restarted worker is a cache that
 * rebuilds the world on every failure — which is every failure this suite
 * exists to find.
 */
const CACHE_DIR = path.join(os.tmpdir(), "sahayak-a11y");
const CACHE_FILE = path.join(CACHE_DIR, "world.json");

/**
 * Two hours. The one perishable thing in here is the unsubmitted attempt, and
 * its paper is deliberately given a four-hour clock so the cache outlives it.
 */
const CACHE_MAX_AGE_MS = 2 * 3_600_000;

/** How long the paper behind the in-progress attempt runs for. */
const LONG_PAPER_MINUTES = 240;

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

type Ids = {
  createdAt: number;
  organizationId: string;
  classId: string;
  subjectId: string;
  chapterId: string;
  conceptId: string;
  questionId: string;
  assessmentId: string;
  assignmentId: string;
  /** The exam series the world's paper was grouped into. */
  seriesId: string;
  studentUserId: string;
  submittedAttemptId: string;
  openAttemptId: string;
  mistakeId: string | null;
  practiceSessionId: string | null;
  reportId: string | null;
  inviteToken: string | null;
  /**
   * A throwaway account for the keyboard sign-in flow. Storage state is a
   * session, not a credential, and the one flow that has to type a password
   * needs the password.
   */
  signin: { email: string; password: string };
  /** Why an optional fixture is missing, so a skip can say so out loud. */
  notes: Record<string, string>;
  states: {
    teacher: StorageState;
    student: StorageState;
    admin: StorageState;
    parent: StorageState | null;
  };
};

type Fixtures = {
  ids: Ids;
  teacher: BrowserContext;
  student: BrowserContext;
  admin: BrowserContext;
  parent: BrowserContext | null;
  anon: BrowserContext;
};

let fx: Fixtures;

// ---------------------------------------------------------------------------
// The direct connection
// ---------------------------------------------------------------------------

/**
 * Curriculum ids are not reachable through any tenant-facing API — the
 * curriculum plane carries no organization_id and the app role has no write
 * grant on it — so the three concepts a report needs are read directly, the
 * same way the harness reads the one it needs.
 */
let sql: pg.Client | null = null;

async function db(): Promise<pg.Client> {
  if (sql) return sql;
  const next = new pg.Client({ connectionString: process.env.DIRECT_URL });
  await next.connect();
  sql = next;
  return next;
}

// ---------------------------------------------------------------------------
// Building the world
// ---------------------------------------------------------------------------

type QuestionSpec = {
  subjectId: string;
  chapterId: string;
  outcomeId: string;
  stem: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
};

async function createApprovedQuestion(
  request: APIRequestContext,
  spec: QuestionSpec,
): Promise<string> {
  const created = await request.post("/api/questions/", {
    data: {
      type: "MCQ",
      subjectId: spec.subjectId,
      chapterId: spec.chapterId,
      difficulty: spec.difficulty,
      marks: 1,
      stem: spec.stem,
      options: [
        { key: "A", text: "Angle-angle similarity", isCorrect: true },
        { key: "B", text: "Equal areas alone", isCorrect: false },
        { key: "C", text: "Equal perimeters alone", isCorrect: false },
      ],
      hint: "Count how many facts you have been given.",
      explanation: "Two equal angles force the third.",
      outcomeIds: [spec.outcomeId],
    },
  });
  if (!created.ok()) {
    throw new Error(`createQuestion: ${created.status()} ${await created.text()}`);
  }
  const { id } = (await created.json()) as { id: string };

  const approved = await request.post(`/api/questions/${id}/`, {
    data: { action: "approve" },
  });
  if (!approved.ok()) {
    throw new Error(`approveQuestion: ${approved.status()} ${await approved.text()}`);
  }
  return id;
}

async function publishAndAssign(
  request: APIRequestContext,
  spec: {
    title: string;
    subjectId: string;
    gradeId: string;
    classId: string;
    durationMinutes: number;
    questionIds: string[];
  },
): Promise<{ assessmentId: string; assignmentId: string }> {
  const created = await request.post("/api/assessments/", {
    data: {
      title: spec.title,
      subjectId: spec.subjectId,
      gradeId: spec.gradeId,
      durationMinutes: spec.durationMinutes,
      totalMarks: spec.questionIds.length,
    },
  });
  if (!created.ok()) {
    throw new Error(`createAssessment: ${created.status()} ${await created.text()}`);
  }
  const assessmentId = ((await created.json()) as { id: string }).id;

  const set = await request.put(`/api/assessments/${assessmentId}/questions/`, {
    data: { questionIds: spec.questionIds },
  });
  if (!set.ok()) {
    throw new Error(`setQuestions: ${set.status()} ${await set.text()}`);
  }

  const published = await request.post(`/api/assessments/${assessmentId}/publish/`, {
    data: {},
  });
  if (!published.ok()) {
    throw new Error(`publish: ${published.status()} ${await published.text()}`);
  }

  const assigned = await request.post("/api/assignments/", {
    data: {
      assessmentId,
      classId: spec.classId,
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      maxAttempts: 3,
      resultsPolicy: "IMMEDIATE",
    },
  });
  if (!assigned.ok()) {
    throw new Error(`assign: ${assigned.status()} ${await assigned.text()}`);
  }
  return {
    assessmentId,
    assignmentId: ((await assigned.json()) as { id: string }).id,
  };
}

/**
 * Sit a paper. `answer` is the option key to choose on every question — "A" is
 * the correct one on every question this suite creates, so "B" is a wrong
 * answer everywhere and produces exactly the settled mistakes the bank needs.
 */
async function sit(
  request: APIRequestContext,
  assignmentId: string,
  options: { answer: "A" | "B" | null; submit: boolean },
): Promise<string> {
  const started = await request.post("/api/attempts/", {
    data: { assignmentId, clientAttemptId: randomUUID() },
  });
  if (!started.ok()) {
    throw new Error(`startAttempt: ${started.status()} ${await started.text()}`);
  }
  const { attemptId } = (await started.json()) as { attemptId: string };

  if (options.answer !== null) {
    const player = (await (
      await request.get(`/api/attempts/${attemptId}/`)
    ).json()) as { questions: { assessmentQuestionId: string }[] };

    const saved = await request.patch(`/api/attempts/${attemptId}/answers/`, {
      data: {
        answers: player.questions.map((question) => ({
          assessmentQuestionId: question.assessmentQuestionId,
          response: { kind: "choice", keys: [options.answer] },
          timeSpentSeconds: 40,
          clientSeq: 1,
        })),
      },
    });
    if (!saved.ok()) {
      throw new Error(`saveAnswers: ${saved.status()} ${await saved.text()}`);
    }
  }

  if (options.submit) {
    const submitted = await request.post(`/api/attempts/${attemptId}/submit/`, {
      data: { reason: "MANUAL" },
    });
    if (!submitted.ok()) {
      throw new Error(`submit: ${submitted.status()} ${await submitted.text()}`);
    }
  }

  return attemptId;
}

/**
 * Promote to platform admin and re-establish the session.
 *
 * `makePlatformAdmin()` in the harness cannot be used: it re-signs in through
 * `signInTeacher()`, which posts `{ email, password }` while
 * `/api/auth/signin/` has taken `{ identifier, password }` since the student
 * sign-in was added — so it is a hard 400. The harness is another agent's file
 * this week, so the working version lives here and the broken one is reported
 * rather than edited.
 *
 * The flag itself goes over DIRECT_URL because there is deliberately no in-app
 * way to grant it, and the session has to be minted again afterwards because
 * the flag is read when a session is created.
 */
async function promoteToPlatformAdmin(
  context: BrowserContext,
  teacher: { email: string; password: string },
): Promise<void> {
  const client = await db();
  await client.query("update users set platform_admin = true where email = $1", [
    teacher.email,
  ]);

  const signedIn = await context.request.post("/api/auth/signin/", {
    data: { identifier: teacher.email, password: teacher.password },
  });
  if (!signedIn.ok()) {
    throw new Error(
      `promoteToPlatformAdmin: ${signedIn.status()} ${await signedIn.text()}`,
    );
  }
}

async function buildWorld(browser: Browser): Promise<Ids> {
  const notes: Record<string, string> = {};

  const teacher = await browser.newContext();
  const world = await makeWorld(teacher, { questionCount: 2 });
  await grantFullPlan(world.teacher.organizationId);

  const client = await db();

  // The concept behind the world's own outcome. Practice needs one, and so
  // does the platform console's concept page.
  const conceptRow = await client.query<{ concept_id: string }>(
    "select concept_id from concept_outcomes where learning_outcome_id = $1 limit 1",
    [world.outcomeId],
  );
  const conceptId = conceptRow.rows[0]!.concept_id;

  // A report refuses below three measured concepts, and a concept needs four
  // undecayed answers. So: three outcomes in the same chapter, each covered by
  // a DIFFERENT concept at full mapping weight, five questions apiece.
  const spread = await client.query<{ outcome_id: string; concept_id: string }>(
    `select co.learning_outcome_id as outcome_id, min(co.concept_id::text) as concept_id
       from concept_outcomes co
       join learning_outcomes lo on lo.id = co.learning_outcome_id
       join topics t on t.id = lo.topic_id
      where t.chapter_id = $1 and co.weight = 1.00
      group by co.learning_outcome_id
      limit 60`,
    [world.chapterId],
  );

  const chosen: { outcome_id: string; concept_id: string }[] = [];
  const usedConcepts = new Set<string>();
  for (const row of spread.rows) {
    if (usedConcepts.has(row.concept_id)) continue;
    usedConcepts.add(row.concept_id);
    chosen.push(row);
    if (chosen.length === 3) break;
  }

  const seed = stamp();
  const request = teacher.request;

  let reportId: string | null = null;
  let measuredAssignmentId: string | null = null;

  if (chosen.length < 3) {
    notes.report =
      `the chapter behind this world covers only ${chosen.length} distinct concepts, ` +
      "and a report refuses below three measured ones";
  } else {
    const measuredQuestions: string[] = [];
    for (const [index, row] of chosen.entries()) {
      for (let n = 0; n < 5; n++) {
        measuredQuestions.push(
          await createApprovedQuestion(request, {
            subjectId: world.subjectId,
            chapterId: world.chapterId,
            outcomeId: row.outcome_id,
            difficulty: n % 2 === 0 ? "MEDIUM" : "HARD",
            stem: `A11y measured item ${index}-${n} ${seed} — which criterion settles it?`,
          }),
        );
      }
    }

    const measured = await publishAndAssign(request, {
      title: `A11y measured paper ${seed}`,
      subjectId: world.subjectId,
      gradeId: world.gradeId,
      classId: world.classId,
      durationMinutes: 60,
      questionIds: measuredQuestions,
    });
    measuredAssignmentId = measured.assignmentId;
  }

  // A separate paper with a four-hour clock, so the unsubmitted attempt behind
  // /student/attempt/[id] outlives the cache rather than being swept mid-suite.
  const longQuestions: string[] = [];
  for (let n = 0; n < 2; n++) {
    longQuestions.push(
      await createApprovedQuestion(request, {
        subjectId: world.subjectId,
        chapterId: world.chapterId,
        outcomeId: world.outcomeId,
        difficulty: "EASY",
        stem: `A11y unfinished item ${n} ${seed} — which criterion applies here?`,
      }),
    );
  }
  const long = await publishAndAssign(request, {
    title: `A11y long paper ${seed}`,
    subjectId: world.subjectId,
    gradeId: world.gradeId,
    classId: world.classId,
    durationMinutes: LONG_PAPER_MINUTES,
    questionIds: longQuestions,
  });

  // ---- the student -------------------------------------------------------
  const student = await browser.newContext();
  const roster = world.students[0]!;
  await signInStudent(student, roster.phone);

  // Wrong on the world's own paper: that is what settles into the mistake bank
  // and what leaves those questions eligible for practice, since a question
  // answered correctly is withheld for thirty days and a wrong one comes back.
  const submittedAttemptId = await sit(student.request, world.assignmentId, {
    answer: "B",
    submit: true,
  });

  if (measuredAssignmentId) {
    await sit(student.request, measuredAssignmentId, { answer: "A", submit: true });
  }

  const openAttemptId = await sit(student.request, long.assignmentId, {
    answer: null,
    submit: false,
  });

  // ---- the mistake bank --------------------------------------------------
  let mistakeId: string | null = null;
  const mistakes = await student.request.get("/api/student/mistakes/");
  if (mistakes.ok()) {
    const body = (await mistakes.json()) as { mistakes: { id: string }[] };
    mistakeId = body.mistakes[0]?.id ?? null;
  }
  if (!mistakeId) notes.mistake = "no settled wrong answer was recorded";

  // ---- practice ----------------------------------------------------------
  let practiceSessionId: string | null = null;
  const practice = await student.request.post("/api/practice/sessions/", {
    data: { conceptId, source: "SELF_SELECTED", questionCount: 2 },
  });
  if (practice.ok()) {
    const body = (await practice.json()) as { sessionId?: string; id?: string };
    practiceSessionId = body.sessionId ?? body.id ?? null;
  }
  if (!practiceSessionId) {
    notes.practice = `starting a set refused: ${practice.status()} ${await practice
      .text()
      .catch(() => "")}`.slice(0, 200);
  }

  // ---- the report --------------------------------------------------------
  if (measuredAssignmentId) {
    const generated = await request.post("/api/reports/", {
      data: {
        studentUserId: roster.userId,
        periodStart: new Date(Date.now() - 120 * 86_400_000).toISOString(),
        periodEnd: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    if (generated.ok()) {
      const body = (await generated.json()) as { reportId?: string; id?: string };
      reportId = body.reportId ?? body.id ?? null;
    }
    if (!reportId) {
      notes.report = `generating a report refused: ${generated.status()} ${await generated
        .text()
        .catch(() => "")}`.slice(0, 200);
    }
  }

  // ---- the parent --------------------------------------------------------
  const parentPhone = phoneFor(`${stamp()}${Math.floor(Math.random() * 100)}`);
  let parentState: StorageState | null = null;
  let parent: BrowserContext | null = null;

  const invited = await request.post(`/api/students/${roster.userId}/parents/`, {
    data: { phone: parentPhone, relationship: "MOTHER" },
  });
  if (invited.ok()) {
    const { token } = (await invited.json()) as { token: string };
    parent = await browser.newContext();

    // The build under test runs with NODE_ENV=production, so the request route
    // returns no `devCode` — and there is no SMS provider anywhere yet, which
    // is a real gap in the product rather than one in this file. The code is
    // therefore issued straight onto the row, exactly as `signInStudent` does.
    const code = "246813";
    await client.query("delete from login_codes where phone = $1", [parentPhone]);
    await client.query("select app_auth_issue_code($1, $2, $3)", [
      parentPhone,
      createHash("sha256").update(`${parentPhone}:${code}`, "utf8").digest(),
      new Date(Date.now() + 5 * 60_000),
    ]);

    const accepted = await parent.request.post("/api/parent/accept/", {
      data: { token, phone: parentPhone, code, fullName: "E2E Parent" },
    });
    if (accepted.ok()) {
      parentState = await parent.storageState();
    } else {
      notes.parent = `accepting the invitation refused: ${accepted.status()} ${await accepted
        .text()
        .catch(() => "")}`.slice(0, 200);
    }
    await parent.close();
  } else {
    notes.parent = `inviting a parent refused: ${invited.status()}`;
  }

  // A SECOND invitation, left unaccepted, so /parent/link/[token] has something to
  // show. Accepting consumes the first one.
  let inviteToken: string | null = null;
  const second = await request.post(
    `/api/students/${world.students[1]!.userId}/parents/`,
    {
      data: {
        phone: phoneFor(`${stamp()}${Math.floor(Math.random() * 100)}`),
        relationship: "FATHER",
      },
    },
  );
  if (second.ok()) {
    inviteToken = ((await second.json()) as { token: string }).token;
  } else {
    notes.invitation = `a second invitation refused: ${second.status()}`;
  }

  // ---- the platform admin ------------------------------------------------
  const admin = await browser.newContext();
  const adminTeacher = await signUpTeacher(admin, "E2E Platform Admin");
  await promoteToPlatformAdmin(admin, adminTeacher);

  // ---- an account for the keyboard sign-in flow --------------------------
  const keyboard = await browser.newContext();
  const keyboardTeacher = await signUpTeacher(keyboard, "E2E Keyboard Teacher");
  await keyboard.close();

  const ids: Ids = {
    createdAt: Date.now(),
    organizationId: world.teacher.organizationId,
    classId: world.classId,
    subjectId: world.subjectId,
    chapterId: world.chapterId,
    conceptId,
    questionId: world.questionIds[0]!,
    assessmentId: world.assessmentId,
    assignmentId: world.assignmentId,
    seriesId: world.seriesId,
    studentUserId: roster.userId,
    submittedAttemptId,
    openAttemptId,
    mistakeId,
    practiceSessionId,
    reportId,
    inviteToken,
    signin: { email: keyboardTeacher.email, password: keyboardTeacher.password },
    notes,
    states: {
      teacher: await teacher.storageState(),
      student: await student.storageState(),
      admin: await admin.storageState(),
      parent: parentState,
    },
  };

  await teacher.close();
  await student.close();
  await admin.close();

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(ids), "utf8");

  return ids;
}

function cached(): Ids | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const ids = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Ids;
    if (Date.now() - ids.createdAt > CACHE_MAX_AGE_MS) return null;
    return ids;
  } catch {
    return null;
  }
}

/** A cached session is only useful if it is still a session. */
async function stillSignedIn(context: BrowserContext): Promise<boolean> {
  const response = await context.request.get("/api/classes/");
  return response.status() !== 401;
}

test.beforeAll(async ({ browser }) => {
  // Building the world from nothing is a signup, a roster, nineteen approved
  // questions, three papers and four sittings, and the file's 90-second budget
  // is not enough for it. Reusing the cache takes about a second, so the long
  // timeout only ever applies to the run that has to build.
  test.setTimeout(300_000);

  let ids = cached();

  if (ids) {
    const teacher = await browser.newContext({ storageState: ids.states.teacher });
    if (!(await stillSignedIn(teacher))) {
      await teacher.close();
      ids = null;
    } else {
      await teacher.close();
    }
  }

  if (!ids) ids = await buildWorld(browser);

  fx = {
    ids,
    teacher: await browser.newContext({ storageState: ids.states.teacher }),
    student: await browser.newContext({ storageState: ids.states.student }),
    admin: await browser.newContext({ storageState: ids.states.admin }),
    parent: ids.states.parent
      ? await browser.newContext({ storageState: ids.states.parent })
      : null,
    anon: await browser.newContext(),
  };
});

test.afterAll(async () => {
  await fx?.teacher.close();
  await fx?.student.close();
  await fx?.admin.close();
  await fx?.parent?.close();
  await fx?.anon.close();
  if (sql) {
    await sql.end();
    sql = null;
  }
  await closeDb();
});

// ---------------------------------------------------------------------------
// Visiting
// ---------------------------------------------------------------------------

/**
 * Open a page and prove it is the page.
 *
 * Every one of these surfaces is gated by its layout, so a broken fixture
 * lands on `/signin` — which is a perfectly accessible page, and would turn
 * forty-nine route checks green while proving nothing about the routes.
 */
async function visit(
  context: BrowserContext,
  url: string,
  landsOn = url,
): Promise<Page> {
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

  const landed = new URL(page.url()).pathname;
  const status = response?.status() ?? 0;
  expect(
    landed,
    `${url} did not render (HTTP ${status}); the browser ended up at ${landed}`,
  ).toBe(landsOn);

  return page;
}

type Route = {
  /** The path as it appears in the app, which is also the test's name. */
  route: string;
  /** Resolved at run time, because most of these carry an id. */
  url: () => string;
  context: () => BrowserContext | null;
  /**
   * Where the browser actually stops, when that is not `url`.
   *
   * `/` is the only one: it is a router, not a page — it holds a session
   * check and four redirects and renders no markup of its own.
   */
  landsOn?: string;
  /** A reason to skip, or null. Only ever "this cannot be reached". */
  blocked?: () => string | null;
};

function check(group: string, routes: Route[]): void {
  test.describe(group, () => {
    for (const entry of routes) {
      test(`axe: ${entry.route}`, async () => {
        const reason = entry.blocked?.() ?? null;
        test.skip(reason !== null, reason ?? "");

        const context = entry.context();
        expect(context, `${entry.route}: no signed-in context was built`).not.toBeNull();

        const page = await visit(context!, entry.url(), entry.landsOn);
        try {
          await expectNoViolations(page, entry.route);
        } finally {
          await page.close();
        }
      });
    }
  });
}

const missing = (key: string, what: string) => () =>
  fx.ids.notes[key] ? `${what} — ${fx.ids.notes[key]}` : null;

// ---------------------------------------------------------------------------
// Public — no session at all
// ---------------------------------------------------------------------------

check("public", [
  // A landing page since the September redesign; it used to redirect to sign-in.
  { route: "/", url: () => "/", context: () => fx.anon },
  { route: "/signin/", url: () => "/signin/", context: () => fx.anon },
  { route: "/signin/student/", url: () => "/signin/student/", context: () => fx.anon },
  { route: "/signup/", url: () => "/signup/", context: () => fx.anon },
  { route: "/signin/card/", url: () => "/signin/card/", context: () => fx.anon },
  // What the service worker shows when a page cannot load.
  { route: "/offline/", url: () => "/offline/", context: () => fx.anon },
]);

// ---------------------------------------------------------------------------
// Teacher
// ---------------------------------------------------------------------------

const t = (route: string, url: () => string): Route => ({
  route,
  url,
  context: () => fx.teacher,
});

check("teacher", [
  t("/teacher/", () => "/teacher/"),
  t("/teacher/classes/", () => "/teacher/classes/"),
  t("/teacher/classes/new/", () => "/teacher/classes/new/"),
  t("/teacher/classes/[id]/", () => `/teacher/classes/${fx.ids.classId}/`),
  t("/teacher/classes/[id]/cards/", () => `/teacher/classes/${fx.ids.classId}/cards/`),
  t("/teacher/classes/[id]/meeting/", () => `/teacher/classes/${fx.ids.classId}/meeting/`),
  t("/teacher/questions/", () => "/teacher/questions/"),
  t("/teacher/questions/new/", () => "/teacher/questions/new/"),
  t("/teacher/questions/generate/", () => "/teacher/questions/generate/"),
  t("/teacher/questions/review/", () => "/teacher/questions/review/"),
  t("/teacher/questions/[id]/", () => `/teacher/questions/${fx.ids.questionId}/`),
  t("/teacher/assessments/", () => "/teacher/assessments/"),
  t("/teacher/assessments/[id]/", () => `/teacher/assessments/${fx.ids.assessmentId}/`),
  t("/teacher/assessments/[id]/review/", () => `/teacher/assessments/${fx.ids.assessmentId}/review/`),
  t("/teacher/series/", () => "/teacher/series/"),
  t("/teacher/series/[id]/", () => `/teacher/series/${fx.ids.seriesId}/`),
  t("/teacher/assignments/[id]/", () => `/teacher/assignments/${fx.ids.assignmentId}/`),
  t("/teacher/assignments/[id]/marking/", () => `/teacher/assignments/${fx.ids.assignmentId}/marking/`),
  t("/teacher/assignments/[id]/results/", () => `/teacher/assignments/${fx.ids.assignmentId}/results/`),
  t("/teacher/assignments/[id]/paper/", () => `/teacher/assignments/${fx.ids.assignmentId}/paper/`),
  t("/teacher/assignments/[id]/sheets/", () => `/teacher/assignments/${fx.ids.assignmentId}/sheets/`),
  t("/teacher/analytics/", () => "/teacher/analytics/"),
  t("/teacher/analytics/[classId]/", () => `/teacher/analytics/${fx.ids.classId}/`),
  t("/teacher/analytics/[classId]/gaps/", () => `/teacher/analytics/${fx.ids.classId}/gaps/`),
  t("/teacher/students/", () => "/teacher/students/"),
  t("/teacher/students/[id]/", () => `/teacher/students/${fx.ids.studentUserId}/`),
  t("/teacher/students/[id]/meeting/", () => `/teacher/students/${fx.ids.studentUserId}/meeting/`),
  t("/teacher/settings/", () => "/teacher/settings/"),
  t("/teacher/copilot/", () => "/teacher/copilot/"),
  t("/teacher/reports/", () => "/teacher/reports/"),
  {
    route: "/teacher/reports/[id]/",
    url: () => `/teacher/reports/${fx.ids.reportId}/`,
    context: () => fx.teacher,
    blocked: () =>
      fx.ids.reportId ? null : (fx.ids.notes.report ?? "no report could be generated"),
  },
]);

// ---------------------------------------------------------------------------
// Institute console — owner plus the admin_console entitlement
// ---------------------------------------------------------------------------

check("institute", [
  t("/institute/", () => "/institute/"),
  t("/institute/teachers/", () => "/institute/teachers/"),
  t("/institute/analytics/", () => "/institute/analytics/"),
  t("/institute/webhooks/", () => "/institute/webhooks/"),
  t("/institute/subscription/", () => "/institute/subscription/"),
]);

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

const s = (route: string, url: () => string): Route => ({
  route,
  url,
  context: () => fx.student,
});

check("student", [
  s("/student/", () => "/student/"),
  s("/student/progress/", () => "/student/progress/"),
  s("/student/plan/", () => "/student/plan/"),
  s("/student/readiness/", () => "/student/readiness/"),
  s("/student/mistakes/", () => "/student/mistakes/"),
  {
    route: "/student/mistakes/[id]/",
    url: () => `/student/mistakes/${fx.ids.mistakeId}/`,
    context: () => fx.student,
    blocked: missing("mistake", "no mistake to open"),
  },
  s("/student/practice/", () => "/student/practice/"),
  {
    route: "/student/practice/[sessionId]/",
    url: () => `/student/practice/${fx.ids.practiceSessionId}/`,
    context: () => fx.student,
    blocked: missing("practice", "no practice set could be started"),
  },
  s("/student/attempt/[id]/", () => `/student/attempt/${fx.ids.openAttemptId}/`),
  s("/student/results/[id]/", () => `/student/results/${fx.ids.submittedAttemptId}/`),
]);

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------

const p = (route: string, url: () => string): Route => ({
  route,
  url,
  context: () => fx.parent,
  blocked: missing("parent", "no parent could be linked"),
});

check("parent", [
  p("/parent/", () => "/parent/"),
  p("/parent/reports/", () => "/parent/reports/"),
  {
    route: "/parent/reports/[id]/",
    url: () => `/parent/reports/${fx.ids.reportId}/`,
    context: () => fx.parent,
    blocked: () =>
      fx.ids.notes.parent
        ? `no parent could be linked — ${fx.ids.notes.parent}`
        : fx.ids.reportId
          ? null
          : (fx.ids.notes.report ?? "no report could be generated"),
  },
  {
    // Unauthenticated by necessity: the person opening it has no account yet.
    route: "/parent/link/[token]/",
    url: () => `/parent/link/${fx.ids.inviteToken}/`,
    context: () => fx.anon,
    blocked: () =>
      fx.ids.inviteToken
        ? null
        : (fx.ids.notes.invitation ?? "no pending invitation exists"),
  },
]);

// ---------------------------------------------------------------------------
// Platform console
// ---------------------------------------------------------------------------

const x = (route: string, url: () => string): Route => ({
  route,
  url,
  context: () => fx.admin,
});

check("platform", [
  x("/admin/curriculum/", () => "/admin/curriculum/"),
  x("/admin/curriculum/[subjectId]/", () => `/admin/curriculum/${fx.ids.subjectId}/`),
  x("/admin/curriculum/chapter/[chapterId]/", () => `/admin/curriculum/chapter/${fx.ids.chapterId}/`),
  x("/admin/curriculum/concepts/", () => "/admin/curriculum/concepts/"),
  x("/admin/curriculum/concepts/[conceptId]/", () => `/admin/curriculum/concepts/${fx.ids.conceptId}/`),
  x("/admin/review/", () => "/admin/review/"),
  x("/admin/review/[subjectId]/", () => `/admin/review/${fx.ids.subjectId}/`),
  x("/admin/review/chapter/[chapterId]/", () => `/admin/review/chapter/${fx.ids.chapterId}/`),
  x("/admin/costs/", () => "/admin/costs/"),
  x("/admin/audit/", () => "/admin/audit/"),
]);

// ---------------------------------------------------------------------------
// Keyboard and focus
// ---------------------------------------------------------------------------

/**
 * DESIGN_SYSTEM.md §14: "Every interactive element reachable and operable by
 * keyboard; visible focus always." globals.css draws the ring —
 * `:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px }`
 * — so the check is that the ring is actually there on whatever the Tab key
 * reached, at whatever the page or a component decided afterwards.
 *
 * An outline of `none`, of `0px`, or in a fully transparent colour is a
 * removed focus indicator whichever of the three did it.
 */
type Focused = {
  selector: string;
  label: string;
  focusVisible: boolean;
  outlineStyle: string;
  outlineWidth: number;
  outlineColor: string;
  boxShadow: string;
  width: number;
  height: number;
};

function readFocus() {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return null;

  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const raw = typeof el.className === "string" ? el.className.trim() : "";
  const classes = raw ? "." + raw.split(/[ ]+/).join(".") : "";

  return {
    selector: (el.id ? tag + "#" + el.id : tag + classes).slice(0, 140),
    label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 48),
    focusVisible: el.matches(":focus-visible"),
    outlineStyle: style.outlineStyle,
    outlineWidth: parseFloat(style.outlineWidth) || 0,
    outlineColor: style.outlineColor,
    boxShadow: style.boxShadow,
    width: rect.width,
    height: rect.height,
  };
}

function invisibleFocus(node: Focused): string | null {
  const transparent = /rgba\([^)]*,\s*0\s*\)/.test(node.outlineColor);
  const ring =
    node.outlineStyle !== "none" && node.outlineWidth >= 2 && !transparent;
  const shadowRing = node.boxShadow !== "none" && node.boxShadow !== "";

  if (!node.focusVisible) {
    return "did not match :focus-visible, so the global ring never applied";
  }
  if (!ring && !shadowRing) {
    return `outline ${node.outlineStyle} ${node.outlineWidth}px ${node.outlineColor}, box-shadow ${node.boxShadow}`;
  }
  if (node.width === 0 || node.height === 0) {
    return "is focusable but has no box, so the ring cannot be seen";
  }
  return null;
}

/**
 * Walk the tab order once.
 *
 * It stops when focus leaves the document — Chromium hands the next Tab to the
 * browser's own chrome — or when it comes back round to where it started. It
 * does NOT stop on a repeated element: two identically labelled buttons in a
 * list are two tab stops, and treating the second as the end of the ring would
 * silently check the first three rows of a page and call it done.
 */
async function tabThrough(page: Page, steps: number): Promise<Focused[]> {
  const seen: Focused[] = [];
  let first: string | null = null;

  for (let index = 0; index < steps; index++) {
    await page.keyboard.press("Tab");
    const node = (await page.evaluate(readFocus)) as Focused | null;
    if (!node) break;

    const fingerprint = `${node.selector}|${node.label}`;
    if (first === null) first = fingerprint;
    else if (fingerprint === first) break;

    seen.push(node);
  }

  return seen;
}

async function assertFocusIsVisible(
  context: BrowserContext,
  url: string,
): Promise<void> {
  const page = await visit(context, url);
  try {
    const nodes = await tabThrough(page, 40);
    expect(nodes.length, `${url}: nothing was reachable with the Tab key`).toBeGreaterThan(
      2,
    );

    const broken = nodes
      .map((node) => ({ node, why: invisibleFocus(node) }))
      .filter((row) => row.why !== null)
      .map((row) => `      ${row.node.selector} ["${row.node.label}"] — ${row.why}`);

    expect(
      broken,
      `${url} focuses elements with no visible focus indicator:\n${broken.join("\n")}`,
    ).toEqual([]);
  } finally {
    await page.close();
  }
}

test("keyboard: every tab stop on the teacher dashboard shows a visible focus ring", async () => {
  await assertFocusIsVisible(fx.teacher, "/teacher/");
});

test("keyboard: every tab stop on the student home shows a visible focus ring", async () => {
  await assertFocusIsVisible(fx.student, "/student/");
});

test("keyboard: the teacher workspace is reachable by Tab and Enter alone", async ({
  browser,
}) => {
  // Signing in is the primary flow every other one is behind. Nothing here
  // touches the mouse: Tab to the fields, type, and submit with Enter.
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto("/signin/", { waitUntil: "domcontentloaded" });

    let landedOnEmail = false;
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press("Tab");
      const id = await page.evaluate(() => document.activeElement?.id ?? "");
      if (id === "identifier") {
        landedOnEmail = true;
        break;
      }
    }
    expect(landedOnEmail, "the email field was not reachable with the Tab key").toBe(
      true,
    );

    await page.keyboard.type(fx.ids.signin.email);
    await page.keyboard.press("Tab");

    const onPassword = await page.evaluate(() => document.activeElement?.id ?? "");
    expect(onPassword, "Tab did not move from the email field to the password").toBe(
      "password",
    );

    await page.keyboard.type(fx.ids.signin.password);
    await page.keyboard.press("Enter");

    await page.waitForURL((url) => url.pathname.startsWith("/teacher"), { timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe("/teacher/");
  } finally {
    await page.close();
    await context.close();
  }
});
