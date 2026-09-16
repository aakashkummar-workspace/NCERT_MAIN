import { createHash } from "node:crypto";
import type { APIRequestContext, BrowserContext } from "@playwright/test";
import pg from "pg";

/**
 * Getting a signed-in browser, and something to look at.
 *
 * ---------------------------------------------------------------------------
 * Setup goes through the API; the flow under test goes through the UI
 * ---------------------------------------------------------------------------
 * A student-attempt test that has to click through signup, a class, a question,
 * a paper and an assignment before it can start is a test that spends ninety
 * seconds proving things three other tests already proved, and breaks whenever
 * any of those five screens changes.
 *
 * So arrangement is API and assertion is UI. The one exception is flow 1 in
 * TESTING.md — signing up IS the thing being tested there, and it drives the
 * real form.
 *
 * `context.request` shares the browser's cookie jar, so authenticating through
 * it leaves the browser signed in. No cookie is ever handled by hand.
 *
 * ---------------------------------------------------------------------------
 * Every spec builds its own world
 * ---------------------------------------------------------------------------
 * Nothing here depends on seed state. The database is shared, never reset, and
 * has months of other suites' data in it — two tests learned that the hard way
 * today by pinning a seeded count that another suite had since changed.
 */

/** Unique enough for a shared database that is never reset. */
export const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * A phone number nothing else is using.
 *
 * Phone uniqueness is GLOBAL and this database is not reset between runs, so a
 * hard-coded number passes once and fails forever afterwards.
 */
export const phoneFor = (seed: string) => `9${String(seed).slice(-9)}`;

let client: pg.Client | null = null;

/**
 * The direct connection, for the two things a browser cannot do: issue an OTP
 * when no SMS provider is configured, and grant platform admin — which has
 * deliberately no in-app path.
 */
async function db(): Promise<pg.Client> {
  if (client) return client;
  const next = new pg.Client({ connectionString: process.env.DIRECT_URL });
  await next.connect();
  client = next;
  return next;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
  }
}

export type Teacher = {
  email: string;
  password: string;
  organizationName: string;
  organizationId: string;
  userId: string;
};

/** Sign up a teacher through the API and leave `context` signed in as them. */
export async function signUpTeacher(
  context: BrowserContext,
  label = "E2E Teacher",
): Promise<Teacher> {
  const seed = stamp();
  const email = `e2e.${seed}@example.test`;
  const password = "a-long-enough-password";
  const organizationName = `E2E Centre ${seed}`;

  const response = await context.request.post("/api/auth/signup/", {
    data: {
      fullName: label,
      email,
      password,
      organizationName,
      organizationType: "TUITION_CENTRE",
      // Required since organizations carry a board. The signup form defaults
      // to CBSE; arranging through the API has to say so explicitly, because
      // the route validates it rather than assuming one.
      boardCode: "CBSE",
    },
  });
  if (!response.ok()) {
    throw new Error(`signUpTeacher: ${response.status()} ${await response.text()}`);
  }

  const sql = await db();
  const org = await sql.query<{ id: string }>(
    "select id from organizations where name = $1",
    [organizationName],
  );
  const user = await sql.query<{ id: string }>(
    "select id from users where email = $1",
    [email],
  );

  return {
    email,
    password,
    organizationName,
    organizationId: org.rows[0]!.id,
    userId: user.rows[0]!.id,
  };
}

/** Sign an existing teacher in on a fresh context. */
export async function signInTeacher(
  context: BrowserContext,
  teacher: Pick<Teacher, "email" | "password">,
): Promise<void> {
  // `identifier`, not `email`: the route has taken an identifier since student
  // sign-in was added, and posting `email` is a hard 400. Nothing caught it
  // because `signUpTeacher` authenticates on its own — this function is only
  // reached when a context has to be re-authenticated, which until the a11y
  // sweep nothing did.
  const response = await context.request.post("/api/auth/signin/", {
    data: { identifier: teacher.email, password: teacher.password },
  });
  if (!response.ok()) {
    throw new Error(`signInTeacher: ${response.status()}`);
  }
}

/**
 * Promote to platform admin.
 *
 * Over the direct connection, because there is deliberately no in-app way to
 * do it — the same reason `scripts/grant-platform-admin.mjs` exists. The
 * session has to be re-established afterwards: the flag is read when the
 * session is created.
 */
export async function makePlatformAdmin(
  context: BrowserContext,
  teacher: Teacher,
): Promise<void> {
  const sql = await db();
  await sql.query("update users set platform_admin = true where email = $1", [
    teacher.email,
  ]);
  await signInTeacher(context, teacher);
}

export type Student = { userId: string; fullName: string; phone: string };

/**
 * Add students to a class by pasting a roster, exactly as a teacher would.
 *
 * Returns them in the order they were listed, which is the order the importer
 * reports back.
 */
export async function addStudents(
  request: APIRequestContext,
  classId: string,
  names: string[],
): Promise<Student[]> {
  const rows = names.map((name) => ({
    fullName: name,
    phone: phoneFor(`${stamp()}${Math.floor(Math.random() * 100)}`),
  }));

  const response = await request.post(`/api/classes/${classId}/students/`, {
    data: { text: rows.map((row) => `${row.fullName}, ${row.phone}`).join("\n") },
  });
  if (!response.ok()) {
    throw new Error(`addStudents: ${response.status()} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    outcomes: { fullName: string; status: string; userId: string }[];
  };

  return rows.map((row) => {
    const outcome = body.outcomes.find(
      (candidate) => candidate.fullName === row.fullName,
    );
    if (!outcome || outcome.status !== "added") {
      throw new Error(`addStudents: ${row.fullName} was not added`);
    }
    return { userId: outcome.userId, fullName: row.fullName, phone: row.phone };
  });
}

/**
 * Sign a student in on `context`, leaving the browser signed in as them.
 *
 * The OTP is read from the development response when there is one, and issued
 * directly otherwise. There is no SMS provider configured anywhere yet, which
 * is a real gap in the product rather than a gap in this harness.
 */
export async function signInStudent(
  context: BrowserContext,
  phone: string,
): Promise<void> {
  const sql = await db();
  await sql.query("delete from login_codes where phone = $1", [phone]);

  const requested = await context.request.post("/api/auth/otp/request/", {
    data: { phone },
  });
  const body = (await requested.json().catch(() => null)) as
    | { devCode?: string }
    | null;

  let code = body?.devCode;
  if (!code) {
    code = "246813";
    await sql.query("select app_auth_issue_code($1, $2, $3)", [
      phone,
      createHash("sha256").update(`${phone}:${code}`, "utf8").digest(),
      new Date(Date.now() + 5 * 60_000),
    ]);
  }

  const verified = await context.request.post("/api/auth/otp/verify/", {
    data: { phone, code },
  });
  if (!verified.ok()) {
    throw new Error(`signInStudent: ${verified.status()}`);
  }
}

export type World = {
  teacher: Teacher;
  classId: string;
  className: string;
  gradeId: string;
  subjectId: string;
  chapterId: string;
  outcomeId: string;
  questionIds: string[];
  assessmentId: string;
  assignmentId: string;
  students: Student[];
};

/**
 * A class with a published, assigned paper and two students on the roster.
 *
 * Built through the API in the order a teacher would, so it exercises the real
 * validation on the way past — a world assembled by inserting rows would pass
 * happily with data the product would have refused.
 */
export async function makeWorld(
  context: BrowserContext,
  options: {
    questionCount?: number;
    maxAttempts?: number;
    opensInMs?: number;
    closesInMs?: number;
    resultsPolicy?: "IMMEDIATE" | "AFTER_CLOSE" | "MANUAL";
    studentNames?: string[];
  } = {},
): Promise<World> {
  const request = context.request;
  const teacher = await signUpTeacher(context);
  const seed = stamp();

  // An outcome a concept actually covers, so evidence can reach mastery. Most
  // outcomes are covered by nothing, which is the product's own largest gap.
  const sql = await db();
  const covered = await sql.query<{ id: string }>(
    "select co.learning_outcome_id as id from concept_outcomes co limit 1",
  );
  if (covered.rows.length === 0) {
    throw new Error("makeWorld: no outcome is covered by a concept");
  }

  const picker = await (await request.get("/api/curriculum/picker/")).json();
  const outcome = picker.outcomes.find(
    (row: { id: string }) => row.id === covered.rows[0]!.id,
  );
  const chapter = picker.chapters.find(
    (row: { id: string }) => row.id === outcome.chapterId,
  );

  // The grade ids are not exposed by an API, so they come off the form the
  // teacher would be filling in.
  const page = await context.newPage();
  await page.goto("/teacher/classes/new/");
  const html = await page.content();
  await page.close();

  const gradeIds = [
    ...new Set(
      [...(html.split('id="subjectId"')[0] ?? "").matchAll(/value="([0-9a-f-]{36})"/g)].map(
        (match) => match[1]!,
      ),
    ),
  ];

  let classId: string | null = null;
  let gradeId: string | null = null;
  const className = `Class 10-E2E ${seed.slice(-4)}`;
  for (const candidate of gradeIds) {
    const attempt = await request.post("/api/classes/", {
      data: {
        name: className,
        gradeId: candidate,
        subjectId: chapter.subjectId,
        academicYear: "2026-27",
      },
    });
    if (attempt.ok()) {
      classId = (await attempt.json()).id;
      gradeId = candidate;
      break;
    }
  }
  if (!classId || !gradeId) throw new Error("makeWorld: no class could be created");

  const students = await addStudents(
    request,
    classId,
    options.studentNames ?? ["Arun Kumar", "Meera Nair"],
  );

  const questionCount = options.questionCount ?? 2;
  const questionIds: string[] = [];
  for (let index = 0; index < questionCount; index++) {
    const created = await request.post("/api/questions/", {
      data: {
        type: "MCQ",
        subjectId: chapter.subjectId,
        chapterId: chapter.id,
        difficulty: index % 2 === 0 ? "EASY" : "MEDIUM",
        marks: 1,
        stem: `E2E question ${index} ${seed} — which criterion applies here?`,
        options: [
          { key: "A", text: "Angle-angle similarity", isCorrect: true },
          { key: "B", text: "Equal areas", isCorrect: false },
          { key: "C", text: "Equal perimeters", isCorrect: false },
        ],
        hint: "Count how many facts you have been given.",
        explanation: "Two equal angles force the third.",
        outcomeIds: [outcome.id],
      },
    });
    const id = (await created.json()).id;
    await request.post(`/api/questions/${id}/`, { data: { action: "approve" } });
    questionIds.push(id);
  }

  const assessment = await request.post("/api/assessments/", {
    data: {
      title: `E2E paper ${seed}`,
      subjectId: chapter.subjectId,
      gradeId,
      durationMinutes: 30,
      totalMarks: questionCount,
    },
  });
  const assessmentId = (await assessment.json()).id;
  await request.put(`/api/assessments/${assessmentId}/questions/`, {
    data: { questionIds },
  });
  await request.post(`/api/assessments/${assessmentId}/publish/`, { data: {} });

  const assigned = await request.post("/api/assignments/", {
    data: {
      assessmentId,
      classId,
      opensAt: new Date(Date.now() + (options.opensInMs ?? -60_000)).toISOString(),
      closesAt: new Date(Date.now() + (options.closesInMs ?? 24 * 3600_000)).toISOString(),
      maxAttempts: options.maxAttempts ?? 3,
      resultsPolicy: options.resultsPolicy ?? "IMMEDIATE",
    },
  });
  if (!assigned.ok()) {
    throw new Error(`makeWorld: assign failed ${assigned.status()} ${await assigned.text()}`);
  }

  return {
    teacher,
    classId,
    className,
    gradeId,
    subjectId: chapter.subjectId,
    chapterId: chapter.id,
    outcomeId: outcome.id,
    questionIds,
    assessmentId,
    assignmentId: (await assigned.json()).id,
    students,
  };
}

/** Put an organisation on a plan that includes everything gated by one. */
export async function grantFullPlan(organizationId: string): Promise<void> {
  const sql = await db();
  const plan = await sql.query<{ id: string }>(
    "select id from plans where code = 'institute'",
  );
  await sql.query(
    `insert into subscriptions
       (id, organization_id, plan_id, status, current_period_start, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, 'ACTIVE', now(), now(), now())
     on conflict (organization_id) do update set plan_id = excluded.plan_id`,
    [organizationId, plan.rows[0]!.id],
  );
}
