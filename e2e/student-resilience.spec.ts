import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import pg from "pg";
import { closeDb, makeWorld, signInStudent, type World } from "./support/harness";

/**
 * The three ways real students lose real work — TESTING.md §4, flow 9 — plus
 * the double submit from §5.
 *
 *   refresh mid-test · offline then online · the clock running out while the
 *   tab is in the background
 *
 * Everything asserted here is a rule the product already states about itself
 * (CLAUDE.md, "Attempts and the player"), so a failure here is a product bug
 * and never a test that has drifted:
 *
 *   - the clock is derived from `startedAt + durationMs` and never counted
 *     down, so a reload must not restart it and a tab that was suspended for
 *     forty minutes must come back correct;
 *   - the autosave queue is written to localStorage BEFORE the request, so a
 *     tab that dies between the two still holds the answer;
 *   - offline is `navigator.onLine && the last request landed`;
 *   - submitting is idempotent and returns 200 with the first result.
 */

let sql: pg.Client | null = null;

/**
 * The direct connection, used for exactly one thing: moving an attempt's
 * stored `expiresAt` into the past, and reading back what the server decided.
 *
 * The alternative is waiting the paper's real thirty minutes. There is no way
 * to arrange a shorter one through the API — a sitting runs at least five
 * minutes and `validateWindow` refuses a window shorter than the paper — and a
 * test that takes half an hour is a test nobody runs. Nothing about the
 * mechanism under test is bypassed: `expires_at` is the column the heartbeat
 * reads, and every assertion below is about what the client then does with it.
 */
async function direct(): Promise<pg.Client> {
  if (sql) return sql;
  const next = new pg.Client({ connectionString: process.env.DIRECT_URL });
  await next.connect();
  sql = next;
  return next;
}

test.afterAll(async () => {
  if (sql) {
    await sql.end();
    sql = null;
  }
  await closeDb();
});

const queueKey = (attemptId: string) => `sahayak-queue-${attemptId}`;

/** The player's clock, in seconds. It is the only MM:SS on the page. */
async function clockSeconds(page: Page): Promise<number> {
  const text = await page.getByText(/^\d{2}:\d{2}$/).first().innerText();
  const [minutes, seconds] = text.trim().split(":").map(Number);
  return (minutes ?? 0) * 60 + (seconds ?? 0);
}

async function startTest(page: Page): Promise<string> {
  await page.goto("/student/");
  await page.getByRole("button", { name: "Start test" }).click();
  await page.waitForURL(/\/student\/attempt\/[0-9a-f-]{36}/);
  await expect(page.getByText(/^Question 1 of \d+$/)).toBeVisible();
  return new URL(page.url()).pathname.split("/").filter(Boolean).pop()!;
}

/** What the client still holds on the device and has not yet had a 200 for. */
async function queued(
  page: Page,
  attemptId: string,
): Promise<{ assessmentQuestionId: string; response: unknown; clientSeq: number }[]> {
  const raw = await page.evaluate(
    (key) => localStorage.getItem(key),
    queueKey(attemptId),
  );
  return raw === null ? [] : JSON.parse(raw);
}

/** Wait until the server has acknowledged everything the client holds. */
async function queueDrained(page: Page, attemptId: string): Promise<void> {
  await expect
    .poll(() => queued(page, attemptId).then((items) => items.length), {
      timeout: 15_000,
    })
    .toBe(0);
}

/** The answers as the SERVER has them — the copy that counts. */
async function serverAnswers(
  context: BrowserContext,
  attemptId: string,
): Promise<Map<number, unknown>> {
  const response = await context.request.get(`/api/attempts/${attemptId}/`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    questions: { position: number; response: unknown }[];
  };
  return new Map(body.questions.map((question) => [question.position, question.response]));
}

async function serverRemainingMs(
  context: BrowserContext,
  attemptId: string,
): Promise<number> {
  const response = await context.request.get(`/api/attempts/${attemptId}/`);
  const body = (await response.json()) as { remainingMs: number };
  return body.remainingMs;
}

type AttemptRow = {
  status: string;
  submit_reason: string | null;
  raw_score: string | null;
  max_score: string | null;
};

async function attemptRow(attemptId: string): Promise<AttemptRow> {
  const client = await direct();
  const result = await client.query<AttemptRow>(
    "select status, submit_reason, raw_score, max_score from attempts where id = $1",
    [attemptId],
  );
  return result.rows[0]!;
}

async function attemptCount(world: World, studentUserId: string): Promise<number> {
  const client = await direct();
  const result = await client.query<{ count: string }>(
    "select count(*)::text as count from attempts where assignment_id = $1 and student_user_id = $2",
    [world.assignmentId, studentUserId],
  );
  return Number(result.rows[0]!.count);
}

/** Move the sitting's clock into the past. See the note on `direct()`. */
async function expireAttempt(attemptId: string): Promise<void> {
  const client = await direct();
  await client.query(
    "update attempts set expires_at = now() - interval '2 seconds' where id = $1",
    [attemptId],
  );
}

/**
 * The tab goes to the background, and comes back.
 *
 * Headless Chromium keeps every page "visible" — `bringToFront()` on a second
 * page does not hide the first — so the state is asserted onto the document
 * and the event dispatched, which is exactly what the player listens for.
 */
async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (isHidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => isHidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/** A world, a signed-in student, and a page. */
async function sitDown(
  // The type named directly rather than derived from `test`'s own signature:
  // `test`'s second parameter is a union with TestDetails, so the derivation
  // collapsed to `never` and took every call site with it.
  browser: Browser,
  options: { world?: Parameters<typeof makeWorld>[1]; fakeClock?: boolean } = {},
) {
  const teacherContext = await browser.newContext();
  const world = await makeWorld(teacherContext, {
    questionCount: 3,
    closesInMs: 6 * 3600_000,
    ...options.world,
  });
  const studentContext = await browser.newContext();
  await signInStudent(studentContext, world.students[0]!.phone);
  const page = await studentContext.newPage();
  // Installed before the first navigation, so the page loads with time flowing
  // normally and only jumps when the test says so.
  if (options.fakeClock) await page.clock.install();
  const attemptId = await startTest(page);
  return { world, teacherContext, studentContext, page, attemptId };
}

// ---------------------------------------------------------------------------
// Variant 1 — refresh mid-test
// ---------------------------------------------------------------------------

test("flow 9a: a refresh mid-test loses nothing, and the clock does not restart", async ({
  browser,
}) => {
  const { world, teacherContext, studentContext, page, attemptId } =
    await sitDown(browser);

  // Q1 answered, Q2 answered and flagged: three pieces of state that all have
  // to survive — the response, the flag, and the count derived from them.
  await page.getByRole("radio", { name: /Angle-angle similarity/ }).check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /Equal areas/ }).check();
  await page.getByRole("button", { name: "Mark for review" }).click();
  await expect(page.getByText("2 of 3 answered")).toBeVisible();

  await queueDrained(page, attemptId);
  const clockBeforeReload = await clockSeconds(page);

  // Deliberate: real elapsed time is what the assertion is about. A clock that
  // restarts on reload and one that carries on are only distinguishable once
  // some time has actually passed.
  await page.waitForTimeout(8_000);
  await page.reload();
  await expect(page.getByText("Question 1 of 3")).toBeVisible();

  // Nothing lost. The state comes back from the server, not from the tab that
  // was just thrown away.
  await expect(
    page.getByRole("radio", { name: /Angle-angle similarity/ }),
  ).toBeChecked();
  await expect(page.getByText("2 of 3 answered")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Question 1, answered" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Question 2, marked for review" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Question 3, not answered" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Question 2, marked for review" }).click();
  await expect(page.getByRole("radio", { name: /Equal areas/ })).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Marked", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  // The clock carried on across the refresh rather than starting again, and it
  // agrees with the server, which is the only clock that counts.
  const clockAfterReload = await clockSeconds(page);
  expect(clockAfterReload).toBeLessThanOrEqual(clockBeforeReload - 7);
  const truth = Math.round((await serverRemainingMs(studentContext, attemptId)) / 1000);
  expect(Math.abs(clockAfterReload - truth)).toBeLessThanOrEqual(3);

  // And the server holds both answers, which is the copy that survives the
  // device entirely.
  const answers = await serverAnswers(studentContext, attemptId);
  expect(answers.get(1)).toEqual({ kind: "choice", keys: ["A"] });
  expect(answers.get(2)).toEqual({ kind: "choice", keys: ["B"] });
  expect(answers.get(3)).toBeNull();

  expect(await attemptCount(world, world.students[0]!.userId)).toBe(1);

  await studentContext.close();
  await teacherContext.close();
});

// ---------------------------------------------------------------------------
// Variant 2 — offline, then online
// ---------------------------------------------------------------------------

test("flow 9b: an answer given offline is on the device first, and syncs on reconnect", async ({
  browser,
}) => {
  const { teacherContext, studentContext, page, attemptId } =
    await sitDown(browser);

  await page.getByRole("radio", { name: /Angle-angle similarity/ }).check();
  await queueDrained(page, attemptId);

  // The school wifi that reaches the router and nothing else.
  await studentContext.setOffline(true);

  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /Equal areas/ }).check();
  await page.getByRole("button", { name: "Mark for review" }).click();

  // The student is told, in the words the product chose: the work is safe on
  // this device.
  await expect(
    page.getByText("Offline — saved on device"),
  ).toBeVisible();

  // On the device BEFORE the request went out — which is the whole reason a
  // tab that dies between the two still has the answer.
  // Leaving question 1 also queues its time and visit totals, so the queue can
  // hold question 1 again — with the answer the server already has. What must
  // be there is the one given offline.
  const pending = await queued(page, attemptId);
  expect(
    pending.filter((item) => JSON.stringify(item.response) === JSON.stringify({ kind: "choice", keys: ["B"] })),
  ).toHaveLength(1);
  expect(
    pending.every((item) => item.response === null || ["A", "B"].includes((item.response as { keys: string[] }).keys[0]!)),
  ).toBe(true);

  // Answering on keeps accumulating rather than blocking: a student mid-exam is
  // never stopped by the network.
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /Equal perimeters/ }).check();
  expect(
    (await queued(page, attemptId)).some(
      (item) => JSON.stringify(item.response) === JSON.stringify({ kind: "choice", keys: ["C"] }),
    ),
  ).toBe(true);
  await expect(page.getByText("3 of 3 answered")).toBeVisible();

  // Back on the network. The player flushes on the `online` event rather than
  // waiting out its five-second timer.
  await studentContext.setOffline(false);
  await queueDrained(page, attemptId);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Everything reached the server, including the one given while offline.
  const answers = await serverAnswers(studentContext, attemptId);
  expect(answers.get(1)).toEqual({ kind: "choice", keys: ["A"] });
  expect(answers.get(2)).toEqual({ kind: "choice", keys: ["B"] });
  expect(answers.get(3)).toEqual({ kind: "choice", keys: ["C"] });

  // And it survives the device: reloaded, the page is rebuilt from the server.
  await page.reload();
  await expect(page.getByText("3 of 3 answered")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Question 2, marked for review" }),
  ).toBeVisible();

  await studentContext.close();
  await teacherContext.close();
});

// ---------------------------------------------------------------------------
// Variant 2b — the same thing, in PRACTICE
// ---------------------------------------------------------------------------

/** The practice outbox, keyed per session so two tabs cannot collide. */
const outboxKey = (sessionId: string) => `sahayak.practice.outbox.${sessionId}`;

async function practiceQueued(
  page: Page,
  sessionId: string,
): Promise<{ practiceAnswerId: string; response: unknown }[]> {
  const raw = await page.evaluate(
    (key) => localStorage.getItem(key),
    outboxKey(sessionId),
  );
  if (raw === null) return [];
  return (JSON.parse(raw) as { entries?: { practiceAnswerId: string; response: unknown }[] })
    .entries ?? [];
}

test("an answer given offline in PRACTICE is on the device first, and syncs on reconnect", async ({
  browser,
}) => {
  const teacherContext = await browser.newContext();
  const world = await makeWorld(teacherContext, { questionCount: 8 });

  // The concept behind the world's own outcome: practice is chosen and
  // measured per concept, as every mastery figure is.
  const client = await direct();
  const conceptRow = await client.query<{ concept_id: string }>(
    "select concept_id from concept_outcomes where learning_outcome_id = $1 limit 1",
    [world.outcomeId],
  );
  const conceptId = conceptRow.rows[0]?.concept_id;
  test.skip(!conceptId, "no concept covers the world's outcome");

  const studentContext = await browser.newContext();
  await signInStudent(studentContext, world.students[0]!.phone);

  const opened = await studentContext.request.post("/api/practice/sessions/", {
    data: { conceptId, source: "SELF_SELECTED", questionCount: 4 },
  });
  expect(opened.ok()).toBe(true);
  const sessionId = ((await opened.json()) as { sessionId: string }).sessionId;

  const page = await studentContext.newPage();
  await page.goto(`/student/practice/${sessionId}/`);
  await expect(page.getByRole("button", { name: "Check" })).toBeVisible();

  // The school wifi that reaches the router and nothing else.
  await studentContext.setOffline(true);

  await page.getByRole("button", { name: /^A / }).click();
  await page.getByRole("button", { name: /Check|Saved/ }).click();

  // Told in the words the product chose, and told the truth: the answer is
  // kept, and the verdict is not being invented on the device.
  await expect(page.getByText(/Saved on this device/)).toBeVisible();
  await expect(page.getByText(/back — nothing is lost/)).toBeVisible();
  await expect(page.getByText("Right.", { exact: true })).toBeHidden();
  await expect(page.getByText("Not this time.", { exact: true })).toBeHidden();

  // On the device BEFORE the request went out, which is the whole reason a tab
  // that dies between the two still holds the answer.
  const pending = await practiceQueued(page, sessionId);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.response).toEqual({ kind: "choice", keys: ["A"] });

  // A reload is deliberately NOT attempted here, and the reason is a real
  // limit worth stating: there is no service worker, so with the connection
  // down the browser cannot fetch the document at all and `page.reload()`
  // fails with ERR_INTERNET_DISCONNECTED. Practice is offline-TOLERANT — an
  // answer already given is kept and sent later — not offline-capable. What
  // the storage entry buys is the tab dying, the phone locking, or the student
  // coming back later: all of those reload with a connection, and the queued
  // answer goes up on mount.

  // Back on the network. The runner flushes on the `online` event rather than
  // waiting out its timer, and the verdict arrives — which is the thing the
  // student was promised and the thing a local mark could never be.
  await studentContext.setOffline(false);
  await expect(page.getByText(/^(Right\.|Not this time\.)$/)).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => practiceQueued(page, sessionId).then((rows) => rows.length), {
      timeout: 20_000,
    })
    .toBe(0);

  // And the server has exactly one answer for it, not two.
  const view = await studentContext.request.get(`/api/practice/sessions/${sessionId}/`);
  const body = (await view.json()) as {
    questions: { practiceAnswerId: string; isCorrect: boolean | null }[];
  };
  const answered = body.questions.filter((row) => row.isCorrect !== null);
  expect(answered).toHaveLength(1);

  await studentContext.close();
  await teacherContext.close();
});

// ---------------------------------------------------------------------------
// Variant 3 — the clock runs out with the tab in the background
// ---------------------------------------------------------------------------

test("flow 9c: the paper's time runs out while the tab is suspended, and it submits itself", async ({
  browser,
}) => {
  const { teacherContext, studentContext, page, attemptId } = await sitDown(
    browser,
    { fakeClock: true },
  );

  await page.getByRole("radio", { name: /Angle-angle similarity/ }).check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /Equal areas/ }).check();
  await queueDrained(page, attemptId);
  expect(await clockSeconds(page)).toBeGreaterThan(25 * 60);

  // The screen locks, the student switches app, the phone suspends the tab.
  await setTabHidden(page, true);

  // Thirty-one minutes pass with no timer running — Playwright's own
  // description of `fastForward` is "the user closing the laptop lid for a
  // while and reopening it later", which is exactly the case that breaks a
  // counted-down clock: it would come back still showing half an hour left,
  // because nothing ticked while the tab was asleep. A clock derived from
  // `startedAt + durationMs` sees the paper is over on its first look.
  await page.clock.fastForward("31:00");

  // They come back to the tab, and the paper is already finished.
  await setTabHidden(page, false);
  await page.waitForURL(/\/student\/results\//, { timeout: 30_000 });

  const row = await attemptRow(attemptId);
  expect(row.status).toBe("SCORED");
  // Flagged as a timeout, not as something the student chose to do.
  expect(row.submit_reason).toBe("TIMEOUT");
  // Both answers given before the tab went to sleep are still there: one right,
  // one wrong, of three.
  expect(Number(row.raw_score)).toBe(1);
  expect(Number(row.max_score)).toBe(3);

  const answers = await serverAnswers(studentContext, attemptId);
  expect(answers.get(1)).toEqual({ kind: "choice", keys: ["A"] });
  expect(answers.get(2)).toEqual({ kind: "choice", keys: ["B"] });

  await expect(page.getByText("33.3%")).toBeVisible();
  await expect(page.getByText("1 / 1")).toHaveCount(1);
  await expect(page.getByText("0 / 1")).toHaveCount(1);

  await studentContext.close();
  await teacherContext.close();
});

test("flow 9c: a tab killed while the clock ran out still ends the paper, with the answers", async ({
  browser,
}) => {
  const { teacherContext, studentContext, page, attemptId } =
    await sitDown(browser);

  await page.getByRole("radio", { name: /Angle-angle similarity/ }).check();
  await queueDrained(page, attemptId);

  // The phone kills the tab outright — no unload, no beacon, nothing.
  await page.close();
  await expireAttempt(attemptId);

  // They open the test again later. A counted clock would have nothing to count
  // from; a derived one knows the paper is over before the page has settled.
  const revived = await studentContext.newPage();
  await revived.goto(`/student/attempt/${attemptId}/`);
  await revived.waitForURL(/\/student\/results\//, { timeout: 30_000 });

  const row = await attemptRow(attemptId);
  expect(row.status).toBe("SCORED");
  expect(row.submit_reason).toBe("TIMEOUT");
  expect(Number(row.raw_score)).toBe(1);

  await expect(revived.getByText("1 / 1")).toHaveCount(1);
  await expect(revived.getByText("— / 1")).toHaveCount(2);

  await studentContext.close();
  await teacherContext.close();
});

// ---------------------------------------------------------------------------
// TESTING.md §5 — double submit
// ---------------------------------------------------------------------------

test("a double submit produces one attempt and one score, and answers 200 both times", async ({
  browser,
}) => {
  const teacherContext = await browser.newContext();
  const world = await makeWorld(teacherContext, {
    questionCount: 3,
    closesInMs: 6 * 3600_000,
  });
  const student = world.students[0]!;
  const studentContext = await browser.newContext();
  await signInStudent(studentContext, student.phone);

  // A double tap on Start, with the key the device minted before the first
  // request left it. Two sittings here would be two papers to mark and one
  // student wondering which is theirs.
  const clientAttemptId = crypto.randomUUID();
  const firstStart = await studentContext.request.post("/api/attempts/", {
    data: { assignmentId: world.assignmentId, clientAttemptId },
  });
  const secondStart = await studentContext.request.post("/api/attempts/", {
    data: { assignmentId: world.assignmentId, clientAttemptId },
  });
  expect(firstStart.status()).toBe(200);
  expect(secondStart.status()).toBe(200);
  const attemptId = (await firstStart.json()).attemptId as string;
  const second = await secondStart.json();
  expect(second.attemptId).toBe(attemptId);
  expect(second.resumed).toBe(true);
  expect(await attemptCount(world, student.userId)).toBe(1);

  const page = await studentContext.newPage();
  await page.goto("/student/");
  await page.getByRole("button", { name: "Resume test" }).click();
  await page.waitForURL(/\/student\/attempt\//);
  await page.getByRole("radio", { name: /Angle-angle similarity/ }).check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /Angle-angle similarity/ }).check();
  await queueDrained(page, attemptId);

  // Two submits at once: a double tap on a connection slow enough that the
  // first request had not answered yet.
  const [firstSubmit, secondSubmit] = await Promise.all([
    studentContext.request.post(`/api/attempts/${attemptId}/submit/`, {
      data: { reason: "MANUAL" },
    }),
    studentContext.request.post(`/api/attempts/${attemptId}/submit/`, {
      data: { reason: "MANUAL" },
    }),
  ]);

  // 200, not 409. The client that retried did nothing wrong, and telling it
  // otherwise leaves a student staring at an error page holding a finished
  // paper.
  expect(firstSubmit.status()).toBe(200);
  expect(secondSubmit.status()).toBe(200);
  const first = await firstSubmit.json();
  const concurrent = await secondSubmit.json();
  expect(first.rawScore).toBe(2);
  expect(concurrent.rawScore).toBe(first.rawScore);
  expect(concurrent.maxScore).toBe(first.maxScore);

  // A third, well after the first has landed: the same result, and said to be
  // one that had already happened.
  const retry = await studentContext.request.post(
    `/api/attempts/${attemptId}/submit/`,
    { data: { reason: "MANUAL" } },
  );
  expect(retry.status()).toBe(200);
  const retried = await retry.json();
  expect(retried.alreadySubmitted).toBe(true);
  expect(retried.rawScore).toBe(2);

  // One attempt, one score.
  expect(await attemptCount(world, student.userId)).toBe(1);
  const row = await attemptRow(attemptId);
  expect(row.status).toBe("SCORED");
  expect(Number(row.raw_score)).toBe(2);

  await page.goto(`/student/results/${attemptId}/`);
  await expect(page.getByText("66.7%")).toBeVisible();

  await studentContext.close();
  await teacherContext.close();
});

test("two Start requests racing each other both get the sitting back", async ({
  browser,
}) => {
  /*
   * This was a real bug, found by this test and fixed in
   * `src/core/attempts/index.ts`.
   *
   * `startAttempt` read for an existing sitting and then inserted, with
   * nothing between the two. Two overlapping requests — a double tap on a
   * flaky connection, which is EXACTLY what `clientAttemptId` exists to
   * survive — both found nothing and both inserted. The unique index on
   * (assignment, student, clientAttemptId) refused the second, the Prisma
   * error escaped the route as a 500 with an EMPTY body, and `StartTest`
   * called `response.json()` on it, threw, and showed the student "We could
   * not reach the server. Check your connection and try again."
   *
   * The server had been reached. Their paper had started. On the exam path.
   *
   * No sitting was ever lost or duplicated — the constraint held, which is why
   * this only ever looked like a network error. The fix is `ON CONFLICT DO
   * NOTHING`: catching the violation afterwards cannot work, because Postgres
   * aborts the whole transaction on a constraint error and the recovery read
   * would fail too.
   */

  const teacherContext = await browser.newContext();
  const world = await makeWorld(teacherContext, { closesInMs: 6 * 3600_000 });
  const student = world.students[0]!;
  const studentContext = await browser.newContext();
  await signInStudent(studentContext, student.phone);

  const clientAttemptId = crypto.randomUUID();
  const [first, second] = await Promise.all([
    studentContext.request.post("/api/attempts/", {
      data: { assignmentId: world.assignmentId, clientAttemptId },
    }),
    studentContext.request.post("/api/attempts/", {
      data: { assignmentId: world.assignmentId, clientAttemptId },
    }),
  ]);

  // What does hold: one sitting, and it is reachable.
  expect(await attemptCount(world, student.userId)).toBe(1);
  const again = await studentContext.request.post("/api/attempts/", {
    data: { assignmentId: world.assignmentId, clientAttemptId },
  });
  expect(again.status()).toBe(200);
  expect((await again.json()).resumed).toBe(true);

  // And what used to fail: BOTH taps are answered, so neither student is told
  // the server is unreachable while holding a paper that has started.
  expect([first.status(), second.status()]).toEqual([200, 200]);

  await studentContext.close();
  await teacherContext.close();
});
