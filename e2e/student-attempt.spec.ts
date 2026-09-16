import { expect, test, type Page } from "@playwright/test";
import { closeDb, makeWorld, signInStudent } from "./support/harness";

/**
 * TESTING.md flows 8, 9 and 10 — the student's own path through a paper.
 *
 * Arrangement is API (harness `makeWorld`), assertion is UI. Every test builds
 * its own organisation: nothing here reads seed data, and the database is
 * shared and never reset.
 *
 * The resilience variants of flow 9 — refresh, offline, timer expiry — live in
 * `student-resilience.spec.ts`, because they are the point of the suite rather
 * than a footnote to it.
 */

test.afterAll(async () => {
  await closeDb();
});

/** The player's clock, in seconds. It is the only MM:SS on the page. */
async function clockSeconds(page: Page): Promise<number> {
  const text = await page.getByText(/^\d{2}:\d{2}$/).first().innerText();
  const [minutes, seconds] = text.trim().split(":").map(Number);
  return (minutes ?? 0) * 60 + (seconds ?? 0);
}

/** Start the one assigned paper and land in the player. Returns the attempt id. */
async function startTest(page: Page): Promise<string> {
  await page.goto("/student/");
  await page.getByRole("button", { name: "Start test" }).click();
  await page.waitForURL(/\/student\/attempt\/[0-9a-f-]{36}/);
  await expect(page.getByText(/^Question 1 of \d+$/)).toBeVisible();
  return new URL(page.url()).pathname.split("/").filter(Boolean).pop()!;
}

/**
 * Wait until the client's queue has drained.
 *
 * `persistQueue` writes the pending answers to localStorage before every
 * request and rewrites it after a successful one, so an empty array is the
 * client saying the server has everything. Waiting on the "Saved" chip would
 * prove nothing: it is also what the page shows before a single answer.
 */
async function queueDrained(page: Page, attemptId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (key) => localStorage.getItem(key),
          `sahayak-queue-${attemptId}`,
        ),
      { timeout: 15_000 },
    )
    .toBe("[]");
}

test("flow 8: the student sees the assigned paper, its window and its facts", async ({
  browser,
}) => {
  const teacherContext = await browser.newContext();
  const world = await makeWorld(teacherContext, {
    questionCount: 3,
    closesInMs: 6 * 3600_000,
    studentNames: ["Arun Kumar", "Meera Nair"],
  });

  const studentContext = await browser.newContext();
  await signInStudent(studentContext, world.students[0]!.phone);
  const page = await studentContext.newPage();
  await page.goto("/student/");

  await expect(page.getByRole("heading", { name: "Hello, Arun" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^E2E paper / }),
  ).toBeVisible();
  await expect(page.getByText(world.className)).toBeVisible();

  // Open, and the window said in the words a student can act on.
  await expect(page.getByText("Open now")).toBeVisible();
  await expect(page.getByText("Closes in 6 hours")).toBeVisible();

  // The facts they need before pressing anything.
  await expect(page.getByRole("term").filter({ hasText: "Questions" })).toBeVisible();
  await expect(page.getByText("30 min")).toBeVisible();
  await expect(page.getByText("0 of 3", { exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: "Start test" })).toBeEnabled();

  await studentContext.close();
  await teacherContext.close();
});

test("flows 9 and 10: answers, marks for review, navigates, submits and sees a score", async ({
  browser,
}) => {
  const teacherContext = await browser.newContext();
  const world = await makeWorld(teacherContext, {
    questionCount: 3,
    closesInMs: 6 * 3600_000,
  });

  const studentContext = await browser.newContext();
  await signInStudent(studentContext, world.students[0]!.phone);
  const page = await studentContext.newPage();

  const attemptId = await startTest(page);

  // The clock opens just under the paper's own 30 minutes and is already
  // running — it is derived from startedAt + durationMs, not handed out whole.
  const opening = await clockSeconds(page);
  expect(opening).toBeLessThanOrEqual(30 * 60);
  expect(opening).toBeGreaterThan(29 * 60 - 30);

  await expect(page.getByText("0 of 3 answered")).toBeVisible();

  // Q1, correct.
  await page.getByRole("radio", { name: /Angle-angle similarity/ }).check();
  await expect(
    page.getByRole("radio", { name: /Angle-angle similarity/ }),
  ).toBeChecked();
  await expect(page.getByText("1 of 3 answered")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Question 1, answered" }),
  ).toBeVisible();

  // Q2, wrong, and marked for review.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Question 2 of 3")).toBeVisible();
  await page.getByRole("radio", { name: /Equal areas/ }).check();

  const markForReview = page.getByRole("button", { name: "Mark for review" });
  await markForReview.click();
  const marked = page.getByRole("button", { name: "Marked", exact: true });
  await expect(marked).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Question 2, marked for review" }),
  ).toBeVisible();

  // Q3, left blank. The last question has nowhere further to go.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Question 3 of 3")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Question 3, not answered" }),
  ).toBeVisible();

  // Back to Q1 through the navigator: the answer is still there.
  await page.getByRole("button", { name: "Question 1, answered" }).click();
  await expect(page.getByText("Question 1 of 3")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: /Angle-angle similarity/ }),
  ).toBeChecked();
  await expect(page.getByText("2 of 3 answered")).toBeVisible();

  await queueDrained(page, attemptId);

  // Submitting asks first, and says what it is about to cost them.
  await page.getByRole("button", { name: "Submit" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("1 question is still blank");
  await expect(confirm).toContainText("You cannot come back to this paper");
  await confirm.getByRole("button", { name: "Submit" }).click();

  await page.waitForURL(/\/student\/results\//);

  // One right, one wrong, one blank. Three different states, and the page says
  // so: a wrong answer is a zero, an untouched one is an em dash and never a
  // zero, and neither is "waiting for a teacher" — nothing here needs a person.
  await expect(page.getByText("33.3%")).toBeVisible();
  await expect(page.getByText("/ 3")).toBeVisible();
  await expect(page.getByText("1 / 1")).toHaveCount(1);
  await expect(page.getByText("0 / 1")).toHaveCount(1);
  await expect(page.getByText("— / 1")).toHaveCount(1);
  await expect(page.getByText("Not correct.")).toHaveCount(1);
  await expect(page.getByText("You left this blank.")).toHaveCount(1);
  await expect(page.getByText("Waiting to be marked.")).toHaveCount(0);
  await expect(page.getByText("marked so far")).toHaveCount(0);

  await studentContext.close();
  await teacherContext.close();
});

test("the answer key waits for the window even under IMMEDIATE results", async ({
  browser,
}) => {
  const teacherContext = await browser.newContext();
  const world = await makeWorld(teacherContext, {
    questionCount: 2,
    closesInMs: 6 * 3600_000,
    resultsPolicy: "IMMEDIATE",
  });

  const studentContext = await browser.newContext();
  await signInStudent(studentContext, world.students[0]!.phone);
  const page = await studentContext.newPage();

  const attemptId = await startTest(page);
  await page.getByRole("radio", { name: /Angle-angle similarity/ }).check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /Angle-angle similarity/ }).check();
  await queueDrained(page, attemptId);

  await page.getByRole("button", { name: "Submit" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Submit" }).click();
  await page.waitForURL(/\/student\/results\//);

  // IMMEDIATE, so the score is theirs the moment they submit.
  await expect(page.getByText("100.0%")).toBeVisible();
  await expect(page.getByText("/ 2")).toBeVisible();

  // The key is a stronger disclosure, and the window is still open — a class
  // sitting in two sessions must not have the first holding the answers.
  await expect(
    page.getByText("The answers open once everyone has finished the paper."),
  ).toBeVisible();
  await expect(page.locator("details")).toHaveCount(0);

  // Withheld from the PAYLOAD, not hidden by CSS. The option texts and the
  // explanation are what the key would look like if it had travelled.
  const withheld = await page.content();
  expect(withheld).not.toContain("Angle-angle similarity");
  expect(withheld).not.toContain("Two equal angles force the third");
  expect(withheld).not.toContain("Equal perimeters");

  // The gate is real, not an absence of data: releasing opens the same page.
  const released = await teacherContext.request.post(
    `/api/assignments/${world.assignmentId}/release/`,
    { data: {} },
  );
  expect(released.status()).toBe(200);

  await page.reload();
  await expect(
    page.getByText("The answers open once everyone has finished the paper."),
  ).toHaveCount(0);
  await page.locator("details").first().click();
  await expect(page.getByText("Angle-angle similarity").first()).toBeVisible();
  await expect(
    page.getByText("Two equal angles force the third.").first(),
  ).toBeVisible();

  await studentContext.close();
  await teacherContext.close();
});
