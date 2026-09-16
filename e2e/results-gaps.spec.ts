import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  closeDb,
  grantFullPlan,
  makeWorld,
  signInStudent,
  stamp,
  type World,
} from "./support/harness";

/**
 * Flows 11 to 13 of TESTING.md section 4: results and release, analytics and
 * its refusals, and the gap-to-intervention loop.
 *
 * ---------------------------------------------------------------------------
 * What is asserted here, and what is not
 * ---------------------------------------------------------------------------
 * The smoke suite already drives every one of these APIs and checks its status
 * codes and payloads. Repeating that in a browser would be slower and prove
 * less. So arrangement goes through the API — students sit papers over HTTP,
 * because clicking through a twelve-question paper four times proves nothing
 * flow 9 has not already proved — and every assertion is on what a teacher
 * actually SEES.
 *
 * The three things that only a rendered page can settle:
 *
 *   - the marking queue is grouped by QUESTION and shows no names, which is a
 *     fact about the screen rather than about the query behind it;
 *   - a mastery figure the product refused is not merely null in a payload,
 *     it is absent from the pixel — the heatmap cell has no digit in it;
 *   - there is no control anywhere on the gaps page that closes a gap.
 *
 * Every test builds its own organisation. The database is shared and never
 * reset, so nothing here may depend on a seeded count.
 */

test.afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Arrangement helpers — all through the API a teacher's browser would use
// ---------------------------------------------------------------------------

type PlayerQuestion = {
  assessmentQuestionId: string;
  type: string;
  options: { key: string; text: string }[] | null;
};

type Reply =
  | { kind: "choice"; keys: string[] }
  | { kind: "text"; value: string };

/** Author a question and approve it, so it can be put on a paper. */
async function approveQuestion(
  context: BrowserContext,
  data: Record<string, unknown>,
): Promise<string> {
  const created = await context.request.post("/api/questions/", { data });
  if (!created.ok()) {
    throw new Error(`approveQuestion: ${created.status()} ${await created.text()}`);
  }
  const { id } = (await created.json()) as { id: string };

  const approved = await context.request.post(`/api/questions/${id}/`, {
    data: { action: "approve" },
  });
  if (!approved.ok()) {
    throw new Error(`approve: ${approved.status()} ${await approved.text()}`);
  }
  return id;
}

/** Build a paper from questions already approved, publish it and assign it. */
async function assignPaper(
  context: BrowserContext,
  world: World,
  options: {
    title: string;
    questionIds: string[];
    totalMarks: number;
    resultsPolicy?: "IMMEDIATE" | "AFTER_CLOSE" | "MANUAL";
  },
): Promise<string> {
  const assessment = await context.request.post("/api/assessments/", {
    data: {
      title: options.title,
      subjectId: world.subjectId,
      gradeId: world.gradeId,
      durationMinutes: 45,
      totalMarks: options.totalMarks,
    },
  });
  if (!assessment.ok()) {
    throw new Error(`assessment: ${assessment.status()} ${await assessment.text()}`);
  }
  const { id: assessmentId } = (await assessment.json()) as { id: string };

  await context.request.put(`/api/assessments/${assessmentId}/questions/`, {
    data: { questionIds: options.questionIds },
  });
  const published = await context.request.post(
    `/api/assessments/${assessmentId}/publish/`,
    { data: {} },
  );
  if (!published.ok()) {
    throw new Error(`publish: ${published.status()} ${await published.text()}`);
  }

  const assigned = await context.request.post("/api/assignments/", {
    data: {
      assessmentId,
      classId: world.classId,
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      maxAttempts: 2,
      resultsPolicy: options.resultsPolicy ?? "MANUAL",
    },
  });
  if (!assigned.ok()) {
    throw new Error(`assign: ${assigned.status()} ${await assigned.text()}`);
  }
  return ((await assigned.json()) as { id: string }).id;
}

/**
 * One sitting, start to submit.
 *
 * `answerFor` returning null leaves the question blank — which is a settled
 * state, not a pending one, and the ledger writes no evidence for it. That is
 * how a student with too little evidence is arranged.
 */
async function sit(
  context: BrowserContext,
  assignmentId: string,
  answerFor: (question: PlayerQuestion, position: number) => Reply | null,
): Promise<void> {
  const started = await context.request.post("/api/attempts/", {
    data: { assignmentId, clientAttemptId: randomUUID() },
  });
  if (!started.ok()) {
    throw new Error(`start: ${started.status()} ${await started.text()}`);
  }
  const { attemptId } = (await started.json()) as { attemptId: string };

  const player = (await (
    await context.request.get(`/api/attempts/${attemptId}/`)
  ).json()) as { questions: PlayerQuestion[] };

  const answers = player.questions
    .map((question, index) => ({ question, response: answerFor(question, index + 1) }))
    .filter((row) => row.response !== null)
    .map((row, index) => ({
      assessmentQuestionId: row.question.assessmentQuestionId,
      response: row.response,
      clientSeq: index + 1,
    }));

  if (answers.length > 0) {
    const patched = await context.request.patch(
      `/api/attempts/${attemptId}/answers/`,
      { data: { answers } },
    );
    if (!patched.ok()) {
      throw new Error(`answers: ${patched.status()} ${await patched.text()}`);
    }
  }

  const submitted = await context.request.post(
    `/api/attempts/${attemptId}/submit/`,
    { data: { reason: "MANUAL" } },
  );
  if (!submitted.ok()) {
    throw new Error(`submit: ${submitted.status()} ${await submitted.text()}`);
  }
}

/**
 * Sit as one student on a context that is reused for all of them.
 *
 * One context per sitting is the obvious shape and the wrong one: a dozen
 * contexts opened and closed inside a single test races Playwright's own trace
 * recording on Windows and fails the test in `context.close()`, which is a
 * failure about the harness and not about the product. The cookies are cleared
 * first, so signing the next student in cannot inherit the last one's session.
 */
async function sitAs(
  students: BrowserContext,
  phone: string,
  assignmentId: string,
  answerFor: (question: PlayerQuestion, position: number) => Reply | null,
): Promise<void> {
  await students.clearCookies();
  await signInStudent(students, phone);
  await sit(students, assignmentId, answerFor);
}

/** The MCQ every question in `makeWorld` is: option A is the right one. */
const RIGHT: Reply = { kind: "choice", keys: ["A"] };
const WRONG: Reply = { kind: "choice", keys: ["B"] };

// ---------------------------------------------------------------------------
// Flow 11 — the teacher sees results and releases them
// ---------------------------------------------------------------------------

test("11 — the marking queue is grouped by question, and hides names until asked", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const teacher = await browser.newContext();
  const students = await browser.newContext();
  const world = await makeWorld(teacher, {
    studentNames: ["Ishani Groupcheck", "Kabir Groupcheck", "Devansh Groupcheck"],
  });
  const seed = stamp();

  const stems = [
    `Explain why two equal angles are enough. ${seed}`,
    `Describe one place a builder uses this. ${seed}`,
  ];
  const questionIds: string[] = [];
  for (const stem of stems) {
    questionIds.push(
      await approveQuestion(teacher, {
        type: "SA",
        subjectId: world.subjectId,
        chapterId: world.chapterId,
        difficulty: "MEDIUM",
        marks: 3,
        stem,
        explanation: "The third angle follows from the first two.",
        outcomeIds: [world.outcomeId],
      }),
    );
  }

  const assignmentId = await assignPaper(teacher, world, {
    title: `Written paper ${seed}`,
    questionIds,
    totalMarks: 6,
  });

  // Each student writes something identifiable, and deliberately NOT their own
  // name — a response carrying the name would make the "names are hidden"
  // assertion below pass for the wrong reason.
  const marks = ["alpha", "beta", "gamma"];
  for (const [index, student] of world.students.entries()) {
    await sitAs(students, student.phone, assignmentId, (_question, position) => ({
      kind: "text",
      value: `Reply ${marks[index]} to question ${position}`,
    }));
  }

  const page = await teacher.newPage();
  await page.goto(`/teacher/assignments/${assignmentId}/marking/`);

  // The top-level grouping is the QUESTION. Two questions, two tabs.
  const tabs = page.getByRole("navigation", { name: "Questions to mark" });
  await expect(tabs.getByRole("button", { name: /Q1/ })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /Q2/ })).toBeVisible();

  // One question's mark scheme on screen, and every answer to THAT question
  // beneath it — three answers from three students, judged against one scheme
  // held in the head. The other question's stem is nowhere on the page.
  await expect(page.getByText(stems[0]!)).toBeVisible();
  await expect(page.getByText(stems[1]!)).toHaveCount(0);
  for (const mark of marks) {
    await expect(page.getByText(`Reply ${mark} to question 1`)).toBeVisible();
  }
  await expect(page.getByText(`Reply ${marks[0]} to question 2`)).toHaveCount(0);
  await expect(page.getByText("3 of 3 still to mark.")).toBeVisible();

  // And the marker is not reading names.
  await expect(page.getByText(/^Answer \d+$/)).toHaveCount(3);
  for (const student of world.students) {
    await expect(page.getByText(student.fullName)).toHaveCount(0);
  }

  // One click away, for the moment a teacher genuinely needs to know.
  await page.getByRole("button", { name: "Show names" }).click();
  for (const student of world.students) {
    await expect(page.getByText(student.fullName)).toBeVisible();
  }
  await expect(page.getByText(/^Answer \d+$/)).toHaveCount(0);

  // Question 2 carries the same three students' answers — grouped by question
  // in both directions, rather than one student's whole paper at a time.
  await tabs.getByRole("button", { name: /Q2/ }).click();
  await expect(page.getByText(stems[1]!)).toBeVisible();
  await expect(page.getByText(stems[0]!)).toHaveCount(0);
  for (const mark of marks) {
    await expect(page.getByText(`Reply ${mark} to question 2`)).toBeVisible();
  }

  await students.close();
  await teacher.close();
});

test("11 — a mark outside the question's range is refused, never clamped", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const teacher = await browser.newContext();
  const students = await browser.newContext();
  const world = await makeWorld(teacher, {
    studentNames: ["Ira Rangecheck"],
  });
  const seed = stamp();

  const questionId = await approveQuestion(teacher, {
    type: "SA",
    subjectId: world.subjectId,
    chapterId: world.chapterId,
    difficulty: "MEDIUM",
    marks: 3,
    stem: `Show that the two triangles are similar. ${seed}`,
    explanation: "Two equal angles force the third.",
    outcomeIds: [world.outcomeId],
  });

  const assignmentId = await assignPaper(teacher, world, {
    title: `Range paper ${seed}`,
    questionIds: [questionId],
    totalMarks: 3,
  });

  await sitAs(students, world.students[0]!.phone, assignmentId, () => ({
    kind: "text",
    value: "The angles at A and B match, so the third one must too.",
  }));

  const page = await teacher.newPage();
  await page.goto(`/teacher/assignments/${assignmentId}/marking/`);

  const answer = page.getByRole("listitem").filter({ hasText: "Answer 1" }).first();
  await expect(answer).toBeVisible();

  // The control itself cannot express an out-of-range mark: halves from 0 to
  // the question's own marks, and nothing above it.
  await expect(answer.getByRole("button", { name: "3", exact: true })).toBeVisible();
  await expect(answer.getByRole("button", { name: "3.5", exact: true })).toHaveCount(0);
  await expect(answer.getByRole("button", { name: "4", exact: true })).toHaveCount(0);

  // So the request is rewritten on the wire to send 30 into a 3-mark box —
  // exactly what a teacher's typo would do if the box were a number field.
  await page.route("**/api/marking/**", async (route) => {
    await route.continue({
      postData: JSON.stringify({ awardedMarks: 30, feedback: null }),
    });
  });
  await answer.getByRole("button", { name: "3", exact: true }).click();

  await expect(answer.getByRole("alert")).toContainText("Give a mark between 0 and 3");
  // Refused, not clamped: nothing was awarded at all.
  await expect(answer.getByText(/\d(\.\d)? \/ 3/)).toHaveCount(0);
  await expect(page.getByText("1 of 1 still to mark.")).toBeVisible();

  await page.unroute("**/api/marking/**");

  // And it did not reach the database either — a clamp would show 3 of 3 here.
  await page.reload();
  await expect(page.getByText("1 of 1 still to mark.")).toBeVisible();

  const again = page.getByRole("listitem").filter({ hasText: "Answer 1" }).first();
  await again.getByRole("button", { name: "2", exact: true }).click();
  await expect(again.getByText("2 / 3")).toBeVisible();
  await expect(page.getByText("Every answer to this question is marked.")).toBeVisible();

  await students.close();
  await teacher.close();
});

test("11 — results release while marking is outstanding, and the screen names how many", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const teacher = await browser.newContext();
  const students = await browser.newContext();
  const world = await makeWorld(teacher, {
    studentNames: ["Aarav Releasecheck", "Nila Releasecheck", "Tara Releasecheck"],
    resultsPolicy: "MANUAL",
  });
  const seed = stamp();

  const questionId = await approveQuestion(teacher, {
    type: "SA",
    subjectId: world.subjectId,
    chapterId: world.chapterId,
    difficulty: "MEDIUM",
    marks: 3,
    stem: `Explain the criterion in your own words. ${seed}`,
    explanation: "Two equal angles force the third.",
    outcomeIds: [world.outcomeId],
  });

  const assignmentId = await assignPaper(teacher, world, {
    title: `Release paper ${seed}`,
    questionIds: [questionId],
    totalMarks: 3,
    resultsPolicy: "MANUAL",
  });

  for (const student of world.students) {
    await sitAs(students, student.phone, assignmentId, () => ({
      kind: "text",
      value: "Because two angles are enough to fix the shape.",
    }));
  }

  // Mark exactly one of the three, so the release happens with marking
  // genuinely outstanding rather than on a finished pile.
  const page = await teacher.newPage();
  await page.goto(`/teacher/assignments/${assignmentId}/marking/`);
  const first = page.getByRole("listitem").filter({ hasText: "Answer 1" }).first();
  await first.getByRole("button", { name: "3", exact: true }).click();
  await expect(first.getByText("3 / 3")).toBeVisible();

  await page.goto(`/teacher/assignments/${assignmentId}/results/`);

  // Every figure carries its denominator — and below three marked papers there
  // is no figure at all, only the reason and the count it was refused over.
  // All four cohort cards, not just the first: below three marked papers there
  // is no figure at all, and the reason names the denominator it was refused
  // over.
  for (const label of ["Class average", "Median", "Highest", "Lowest"]) {
    const stat = page.locator(".ui-stat").filter({ hasText: label });
    await expect(stat).toContainText("—");
    await expect(stat).toContainText(
      "Only 1 of 3 papers are marked — too few to describe the class.",
    );
    await expect(stat).not.toContainText("%");
  }

  await expect(
    page.getByRole("link", { name: "Mark 2 papers" }),
  ).toBeVisible();

  // Releasing is permitted with two papers outstanding, and the dialog says so
  // in the number the teacher cares about rather than asking "are you sure?".
  await page.getByRole("button", { name: "Release results" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Release results to the class?",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "2 papers still have written answers to mark",
  );
  await expect(dialog).toContainText("not a zero");

  await dialog.getByRole("button", { name: "Release" }).click();

  await expect(page.getByText(/^Released /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Release results" })).toHaveCount(0);
  // Released, and still two papers to mark — the twenty are not held back by
  // the four.
  await expect(page.getByRole("link", { name: "Mark 2 papers" })).toBeVisible();

  await students.close();
  await teacher.close();
});

// ---------------------------------------------------------------------------
// Flow 12 — analytics, and the refusal where the evidence is thin
// ---------------------------------------------------------------------------

test("12 — analytics carry their denominator, and render no number where evidence is thin", async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const teacher = await browser.newContext();
  const students = await browser.newContext();
  const world = await makeWorld(teacher, {
    questionCount: 6,
    maxAttempts: 3,
    studentNames: [
      "Priya Measured",
      "Rohan Measured",
      "Sana Measured",
      "Vikram Thinevidence",
    ],
  });
  await grantFullPlan(world.teacher.organizationId);

  // Three students answer all six, so each has six answers on the concept —
  // past the estimator's threshold of four.
  await sitAs(students, world.students[0]!.phone, world.assignmentId, () => RIGHT);
  await sitAs(students, world.students[1]!.phone, world.assignmentId, () => RIGHT);
  await sitAs(students, world.students[2]!.phone, world.assignmentId, (_q, position) =>
    position <= 4 ? RIGHT : WRONG,
  );

  // The fourth answers one question and leaves the rest blank. A blank
  // objective is settled, not pending, so it writes no evidence: one answer,
  // which is below the threshold and must never become a number.
  await sitAs(students, world.students[3]!.phone, world.assignmentId, (_q, position) =>
    position === 1 ? RIGHT : null,
  );

  const page = await teacher.newPage();
  await page.goto(`/teacher/analytics/${world.classId}/`);

  // The refusal, in words, on the class page.
  await expect(
    page.getByText("1 of 4 students have nothing measured yet"),
  ).toBeVisible();
  // Said in words, in the alert that names how many people it is about...
  await expect(
    page.getByRole("status").filter({ hasText: "have nothing measured yet" }),
  ).toContainText("not enough evidence yet");
  // ...counted as its own band on the concept, rather than folded into a low
  // score...
  await expect(page.getByText("1 not enough evidence yet")).toBeVisible();
  // ...and reserved in the legend, so the fifth band reads as a refusal and
  // not as the bottom of the scale.
  await expect(
    page.getByRole("listitem").filter({ hasText: "Not enough evidence yet" }).first(),
  ).toBeVisible();

  // The class figure that DOES exist carries the denominator it was computed
  // over: three measured students, not four.
  await expect(page.getByText(/^\d+% across 3$/)).toBeVisible();

  // The heatmap. Colour is never the only encoding: a measured cell holds the
  // estimate as a number, and the thin one holds a dash and no digit at all.
  const grid = page.getByRole("table");
  await expect(grid).toBeVisible();

  for (const name of ["Priya Measured", "Rohan Measured", "Sana Measured"]) {
    const cell = grid
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("cell")
      .first();
    await expect(cell).toHaveText(/^\d{1,3}$/);
  }

  const thinCell = grid
    .getByRole("row")
    .filter({ hasText: "Vikram Thinevidence" })
    .getByRole("cell")
    .first();
  await expect(thinCell).toHaveText("–");
  await expect(thinCell).not.toHaveText(/\d/);

  // And on the student's own page, where the same refusal has to survive being
  // rendered next to a concept name and a chip.
  await page.goto(`/teacher/students/${world.students[3]!.userId}/`);
  const card = page.getByRole("article").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Not enough evidence yet");
  await expect(card).toContainText("1 of 4 answers so far.");
  // The whole point: no percentage anywhere in it.
  await expect(card).not.toContainText("%");

  // Where there IS enough, the same card shows a figure with its evidence count.
  await page.goto(`/teacher/students/${world.students[0]!.userId}/`);
  const measured = page.getByRole("article").first();
  await expect(measured).toContainText(/\d+%/);
  await expect(measured).toContainText("6 answers");

  await students.close();
  await teacher.close();
});

// ---------------------------------------------------------------------------
// Flow 13 — a gap, a remedial paper in one click, and a baseline that holds
// ---------------------------------------------------------------------------

test("13 — a gap is detected, a remedial paper is built from the card, and the baseline holds", async ({
  browser,
}) => {
  test.setTimeout(300_000);

  const teacher = await browser.newContext();
  const students = await browser.newContext();
  const world = await makeWorld(teacher, {
    questionCount: 6,
    maxAttempts: 3,
    studentNames: ["Anaya Behind", "Bilal Behind", "Chetan Behind", "Dhruv Ahead"],
  });
  await grantFullPlan(world.teacher.organizationId);

  // Three of four measured students below the line. Class scope needs both a
  // fraction and a floor, and three is the floor — two of four is 50% and
  // still only two students.
  for (const student of world.students.slice(0, 3)) {
    await sitAs(students, student.phone, world.assignmentId, () => WRONG);
  }
  await sitAs(students, world.students[3]!.phone, world.assignmentId, () => RIGHT);

  const page = await teacher.newPage();
  await page.goto(`/teacher/analytics/${world.classId}/gaps/`);

  const card = page
    .getByRole("listitem")
    .filter({ hasText: "measured students are below the line" })
    .first();
  await expect(card).toBeVisible();

  // ------------------------------------------------ detected, with both numbers
  //
  // Nobody pressed anything: detection is a reconciliation that ran when the
  // papers were submitted.
  await expect(card).toContainText("3 of 4");
  await expect(card).toContainText(/averaging \d+%/);
  await expect(card.getByText("New")).toBeVisible();

  // ---------------------------------------------- nothing here closes the gap
  await expect(
    page.getByText(
      /A gap closes when the evidence closes it.*Marking one as seen does not close it, and nothing here can\./s,
    ),
  ).toBeVisible();

  // Every control the card offers, read by the name a teacher reads. None of
  // them is a way to make the finding go away.
  const cardControls = [
    ...(await card.getByRole("button").allInnerTexts()),
    ...(await card.getByRole("link").allInnerTexts()),
  ].map((text) => text.trim());
  expect(cardControls.length).toBeGreaterThan(0);
  for (const name of cardControls) {
    expect(
      name,
      `"${name}" looks like a control that closes a gap by hand`,
    ).not.toMatch(/close|resolve|dismiss|archive|ignore|delete|remove|done|fixed/i);
  }

  // Nor anywhere else on the page.
  const pageControls = [
    ...(await page.getByRole("button").allInnerTexts()),
    ...(await page.getByRole("link").allInnerTexts()),
  ].map((text) => text.trim());
  for (const name of pageControls) {
    expect(name).not.toMatch(/close (this|the) gap|resolve|dismiss (this|the) gap/i);
  }

  // Acknowledging says "I have seen this" and leaves it open.
  await card.getByRole("button", { name: "Mark as seen" }).click();
  await expect(card.getByText("Seen")).toBeVisible();
  await expect(card).toContainText("measured students are below the line");
  await expect(card.getByText("Closed")).toHaveCount(0);

  // -------------------------------------------- the remedial paper, from here
  const findingWhenStamped = (
    await card.getByText(/measured students are below the line/).innerText()
  ).trim();

  await card.getByRole("button", { name: "Build a remedial paper" }).click();

  // The preview names who it is for: the students below the line, not the class.
  await expect(card).toContainText("students below the line");
  await expect(card).toContainText("nobody else in the class sees it");

  await card.getByRole("button", { name: "Build and assign it" }).click();

  // Stamped in the same breath as the paper.
  const baseline = card.getByText(/Baseline stamped at/);
  await expect(baseline).toBeVisible();
  const baselineWhenStamped = (await baseline.innerText()).trim();
  expect(baselineWhenStamped).toMatch(/Baseline stamped at \d+% across 3 students/);
  await expect(card).toContainText(/Counts as landed at \d+%/);

  // ------------------------------------- move the mastery underneath the stamp
  //
  // The same three students sit the original paper again and get everything
  // right. Their estimates move; the stamp must not follow them.
  for (const student of world.students.slice(0, 3)) {
    await sitAs(students, student.phone, world.assignmentId, () => RIGHT);
  }

  await page.goto(`/teacher/analytics/${world.classId}/gaps/`);
  const after = page
    .getByRole("listitem")
    .filter({ hasText: "measured students are below the line" })
    .first();
  await expect(after).toBeVisible();

  // The gap's own figure followed the evidence...
  const findingNow = (
    await after.getByText(/measured students are below the line/).innerText()
  ).trim();
  expect(findingNow).not.toBe(findingWhenStamped);

  // ...and the baseline did not. This is the invariant the intervention table
  // exists for: measured against current mastery instead, "improvement" is
  // whatever the number happens to be when somebody looks, which always
  // flatters the intervention and is unfalsifiable.
  const baselineNow = (
    await after.getByText(/Baseline stamped at/).innerText()
  ).trim();
  expect(baselineNow).toBe(baselineWhenStamped);

  // Still being worked on: nothing has been MEASURED, so the gap cannot yet be
  // called one that survived the intervention. PERSISTING used to appear on
  // the next detection pass after any submission, whatever the result.
  await expect(after.getByText("Being worked on")).toBeVisible();
  await expect(after.getByText("Still there after an intervention")).toHaveCount(0);
  await expect(after.getByText("New")).toHaveCount(0);

  await students.close();
  await teacher.close();
});

/**
 * A real bug, found by this test and fixed in `src/core/results/index.ts`.
 *
 * The cohort cards obey the rule — a statistic over half-marked papers is not a
 * smaller statistic, it is a WRONG one. The per-question breakdown on the same
 * page did not: `itemAnalysis` averaged over whatever had been marked, and the
 * page printed it as a percentage with no denominator, directly above its own
 * sentence saying there is no figure yet.
 *
 * So a three-mark question with one of three answers marked read "100%" and
 * "2 answers are still to be marked, so there is no figure yet", one under the
 * other — the exact claim the product refuses four cards higher up.
 *
 * The figure is now refused in `core/`, so it never reaches the component at
 * all. Same reason `Mastery` has no `estimate` field when the band is
 * INSUFFICIENT: a number the product will not stand behind should not exist
 * anywhere a renderer can find it.
 */
test("11: the item breakdown shows no figure while answers are still to be marked", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const teacher = await browser.newContext();
  const students = await browser.newContext();
  const world = await makeWorld(teacher, {
    studentNames: ["Meher Itemcheck", "Yash Itemcheck", "Zoya Itemcheck"],
    resultsPolicy: "MANUAL",
  });
  const seed = stamp();

  const questionId = await approveQuestion(teacher, {
    type: "SA",
    subjectId: world.subjectId,
    chapterId: world.chapterId,
    difficulty: "MEDIUM",
    marks: 3,
    stem: `Set out the proof in full. ${seed}`,
    explanation: "Two equal angles force the third.",
    outcomeIds: [world.outcomeId],
  });

  const assignmentId = await assignPaper(teacher, world, {
    title: `Item paper ${seed}`,
    questionIds: [questionId],
    totalMarks: 3,
  });

  for (const student of world.students) {
    await sitAs(students, student.phone, assignmentId, () => ({
      kind: "text",
      value: "The angles at A and B match, so the third must too.",
    }));
  }

  const page = await teacher.newPage();
  try {
    await page.goto(`/teacher/assignments/${assignmentId}/marking/`);
    const first = page
      .getByRole("listitem")
      .filter({ hasText: "Answer 1" })
      .first();
    await first.getByRole("button", { name: "3", exact: true }).click();
    await expect(first.getByText("3 / 3")).toBeVisible();

    await page.goto(`/teacher/assignments/${assignmentId}/results/`);

    const item = page
      .getByRole("listitem")
      .filter({ hasText: `Set out the proof in full. ${seed}` })
      .first();

    await expect(item).toContainText(
      "2 answers are still to be marked, so there is no figure yet.",
    );
    // ...and therefore must not also be showing one.
    await expect(item).not.toContainText("%");
  } finally {
    // Closed even when the assertion above throws, which by design it does:
    // a context left open poisons the trace artifacts of whatever runs next.
    await students.close();
    await teacher.close();
  }
});
