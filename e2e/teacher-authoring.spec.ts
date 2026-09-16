import { expect, test, type Page } from "@playwright/test";
import {
  closeDb,
  makeWorld,
  phoneFor,
  signUpTeacher,
  stamp,
} from "./support/harness";

/**
 * TESTING.md §4, flows 1–7 — the teacher's half of the loop.
 *
 * ---------------------------------------------------------------------------
 * What is here, and why it is not in the smoke suite
 * ---------------------------------------------------------------------------
 * The HTTP smoke suite already proves the status codes and the payload shapes.
 * Everything below is a claim that can only be settled in a browser:
 *
 *   - a form that a person actually fills in, in the order they fill it
 *   - a validator that runs live and DISABLES the control while it is unhappy,
 *     which is the difference between a refusal a teacher is shown and one
 *     they meet after pressing the button
 *   - a warning that is shown and deliberately does NOT disable anything
 *   - an empty state that is designed, rather than four zeros
 *   - a provider failure that reaches the screen as a sentence, with the
 *     provider's own words nowhere on the page
 *
 * ---------------------------------------------------------------------------
 * Arrangement is API; the flow under test is UI
 * ---------------------------------------------------------------------------
 * `makeWorld()` builds a class, a roster and an approved bank through the real
 * API. The exceptions are flows 1 and 2: signing up and creating a class ARE
 * what is under test there, so those two drive the real forms.
 *
 * Every test builds its own organisation. The database is shared and never
 * reset, so nothing here counts seeded rows or assumes an empty bank.
 */

test.afterAll(async () => {
  await closeDb();
});

/** The value a `datetime-local` input wants: local wall clock, no zone. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Fails the test if the page threw, or if the provider's own words reached it.
 *
 * Collected rather than asserted inline, because "the page did not crash" is a
 * claim about the whole visit and not about one moment in it.
 */
function watchForCrashes(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

// ---------------------------------------------------------------------------
// Flow 1 — signing up
// ---------------------------------------------------------------------------

test("flow 1: signing up through the form lands in an organisation with a designed empty dashboard", async ({
  page,
}) => {
  const crashes = watchForCrashes(page);

  const seed = stamp();
  const organizationName = `E2E Signup Centre ${seed}`;

  await page.goto("/signup/");

  // Every control is reached by its label. A placeholder is not a label, and a
  // form that can only be driven by CSS class is one a screen reader cannot
  // fill in either.
  await page.getByLabel("Your name").fill("Priya Raman");
  await page.getByLabel("Email").fill(`e2e.signup.${seed}@example.test`);
  await page.getByLabel("Password").fill("a-long-enough-password");
  await page.getByLabel("Organisation name").fill(organizationName);
  await page
    .getByLabel("What describes you best?")
    .selectOption("TUITION_CENTRE");
  // The board picker defaults to CBSE, so this only proves the control is
  // there and labelled — a school on another board chooses here and nowhere
  // else, because every read afterwards takes the board from their session.
  await page.getByLabel("Which board do you teach?").selectOption("CBSE");

  await page.getByRole("button", { name: "Create account" }).click();

  await page.waitForURL(/\/teacher\/?$/);

  // The organisation exists and the shell names it — signup created a tenant,
  // not just a user.
  await expect(page.getByText(organizationName).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Priya/, level: 1 }),
  ).toBeVisible();

  // ---- The empty state is designed, not a placeholder ---------------------
  //
  // DESIGN_SYSTEM.md's rule: a StatCard with no data shows an em dash, never a
  // zero, because "0 classes" and "no classes yet" mean opposite things to a
  // teacher and only one of them is a reason to do something. All four cards
  // are empty on a brand-new organisation, so all four must read "—".
  await expect(page.getByText("—", { exact: true })).toHaveCount(4);
  await expect(page.getByText("No class yet")).toBeVisible();
  await expect(page.getByText("No papers set yet")).toBeVisible();
  // There is no class-mastery card at all: it was the single class score the
  // product refuses everywhere else, hard-coded to say there was no evidence.
  await expect(page.getByText("Class mastery", { exact: true })).toHaveCount(0);

  // An EmptyState says what is missing, why it matters, and offers the action.
  await expect(
    page.getByRole("heading", { name: "Your first class is the next step" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create a class" }).first(),
  ).toBeVisible();

  expect(crashes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Flow 2 — creating a class
// ---------------------------------------------------------------------------

test("flow 2: creating a class warns about a name that contradicts the year, and never blocks on it", async ({
  context,
  page,
}) => {
  await signUpTeacher(context, "Class Builder");
  const crashes = watchForCrashes(page);

  await page.goto("/teacher/classes/new/");

  await page.getByLabel("Class year").selectOption({ label: "Class 9" });

  // The filing error the product warns about: a group called "Class 10-A"
  // filed against the Class 9 syllabus. Nothing downstream would look wrong,
  // which is exactly why it is said out loud here.
  const name = page.getByLabel("Class name");
  await name.fill("Class 10-A");

  await expect(
    page.getByText(/but the class year above is Class 9/),
  ).toBeVisible();

  // Warned, never blocked. The name belongs to the teacher; the curriculum
  // does not.
  const create = page.getByRole("button", { name: "Create class" });
  await expect(create).toBeEnabled();

  const className = `Class 9-E2E ${stamp().slice(-5)}`;
  await name.fill(className);
  await expect(
    page.getByText(/but the class year above is Class 9/),
  ).toHaveCount(0);

  await create.click();

  // Straight to the roster, because a class with no students does nothing.
  await page.waitForURL(/\/teacher\/classes\/[0-9a-f-]{36}\/?$/);
  await expect(page.getByRole("heading", { name: className })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Enrol your students" }),
  ).toBeVisible();
  await expect(page.getByLabel("Paste your list, or upload a CSV")).toBeVisible();

  expect(crashes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Flow 3 — the roster
// ---------------------------------------------------------------------------

test("flow 3: a roster imports from a paste, and a bad phone costs the row its sign-in but never its place", async ({
  context,
  page,
}) => {
  const world = await makeWorld(context);
  const crashes = watchForCrashes(page);

  await page.goto(`/teacher/classes/${world.classId}/`);

  const seed = stamp();
  const roster = page.getByLabel("Paste your list, or upload a CSV");

  // ---- Import one: three clean rows ---------------------------------------
  const clean = [
    `Sunita Menon ${seed}, ${phoneFor(`${seed}01`)}`,
    `Rahul Verma ${seed}, ${phoneFor(`${seed}02`)}`,
    `Anjali Bose ${seed}, ${phoneFor(`${seed}03`)}`,
  ].join("\n");

  await page.getByRole("button", { name: "Add more students" }).click();
  await roster.fill(clean);
  await page.getByRole("button", { name: /Verify & Preview/ }).click();

  // Nothing is written until the teacher has seen exactly what will happen,
  // and the preview is produced by the parser that does the import.
  await expect(page.getByText("to enrol")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm & Enrol 3 Students" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Confirm & Enrol 3 Students" }).click();

  // The panel closes and the box empties, so from here the names can only be
  // coming from the roster itself.
  await expect(
    page.getByRole("button", { name: "Add more students" }),
  ).toBeVisible();
  await expect(page.getByText(`Sunita Menon ${seed}`)).toBeVisible();
  await expect(page.getByText(`Rahul Verma ${seed}`)).toBeVisible();
  await expect(page.getByText(`Anjali Bose ${seed}`)).toBeVisible();

  // ---- Import two: a CSV with one deliberately malformed phone -------------
  //
  // The product's rule is "imperfect data is imported, not rejected". A bad
  // phone costs that student their sign-in — and nothing else. Rejecting the
  // row would lose a name off a roster over a typo in a column that is
  // optional in the first place.
  const csv = [
    "Name, Mobile",
    `Kiran Rao ${seed}, ${phoneFor(`${seed}04`)}`,
    `Deepa Iyer ${seed}, 12345`,
  ].join("\n");

  await page.getByRole("button", { name: "Add more students" }).click();
  // The file input lives on its own tab since the roster redesign.
  await page.getByRole("tab", { name: "Upload CSV / Excel" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "roster.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });

  // A CSV is read INTO the same box rather than uploaded past it, so what is
  // about to be imported is what the teacher can see and correct. One parser,
  // both doors.
  await expect(roster).toHaveValue(csv);
  await page.getByRole("button", { name: /Verify & Preview/ }).click();

  // The problem is reported PER ROW, against the line number in the teacher's
  // own file — "something was wrong with your list" is not a fixable message.
  await expect(page.getByText("Line 3:")).toBeVisible();
  await expect(
    page.getByText(/"12345" is not a mobile number we can send a code to/),
  ).toBeVisible();
  await expect(
    page.getByText(/The student was still added/),
  ).toBeVisible();

  // Both rows are still going in: the count is 2, not 1.
  await expect(
    page.getByRole("button", { name: "Confirm & Enrol 2 Students" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Confirm & Enrol 2 Students" }).click();

  await expect(
    page.getByRole("button", { name: "Add more students" }),
  ).toBeVisible();
  await expect(page.getByText(`Kiran Rao ${seed}`)).toBeVisible();
  await expect(page.getByText(`Deepa Iyer ${seed}`)).toBeVisible();

  // And the consequence is surfaced where it will be discovered in time,
  // rather than on exam day: the student is on the roster, marked as unable to
  // receive a code.
  await expect(page.getByText("One student has no mobile number.")).toBeVisible();
  await expect(page.getByText("No mobile", { exact: true })).toBeVisible();

  expect(crashes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Flow 4 — writing a question
// ---------------------------------------------------------------------------

/** The parts of a valid four-option MCQ, so the two tests below differ only in
 *  the thing they are actually testing. */
async function fillMcq(page: Page, stem: string, optionD = "Equal perimeters") {
  // The subject is chosen, never defaulted: a question with no chapter used to
  // be filed silently under whichever subject sorted first.
  await page.getByLabel("Subject", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Question", { exact: true }).fill(stem);
  await page.getByLabel("Option A text").fill("Angle-angle similarity");
  await page.getByLabel("Option B text").fill("Side-side-side similarity");
  await page.getByLabel("Option C text").fill("Equal areas");
  await page.getByLabel("Option D text").fill(optionD);
}

test("flow 4: the live validator blocks on an error a real exam would carry", async ({
  context,
  page,
}) => {
  await signUpTeacher(context, "Question Author");
  const crashes = watchForCrashes(page);

  await page.goto("/teacher/questions/new/");
  await fillMcq(
    page,
    "Which similarity criterion applies when two angles of one triangle equal two of another?",
  );

  // A well-formed question still collects advice — no explanation, no outcome
  // yet — and none of it is an error. Nothing is blocking at this point.
  await expect(page.getByText("Must fix")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as draft" })).toBeEnabled();

  // Two correct options on a single-answer type. Reaching it takes a detour on
  // purpose: on MCQ the correct-answer control MOVES the mark rather than
  // adding one, so the error cannot be typed by accident. Switching to
  // multi-select, ticking a second option and switching back is how a real
  // author would arrive at it — they changed their mind about the type.
  await page.getByLabel("Type").selectOption("MULTI_SELECT");
  await page.getByRole("button", { name: "Mark option B correct" }).click();
  await page.getByLabel("Type").selectOption("MCQ");

  await expect(
    page.getByText(
      /2 options are marked correct, but this type accepts one/,
    ),
  ).toBeVisible();
  await expect(page.getByText("Must fix").first()).toBeVisible();

  // An error BLOCKS. This is the whole difference between the two severities,
  // and it is a claim about a disabled attribute that only a browser can make.
  await expect(page.getByRole("button", { name: "Save as draft" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save and approve" }),
  ).toBeDisabled();

  // Moving the mark back to a single option clears it live, with no round trip.
  await page.getByRole("button", { name: "Mark option A correct" }).click();
  await expect(
    page.getByText(/options are marked correct, but this type accepts one/),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as draft" })).toBeEnabled();

  expect(crashes).toEqual([]);
});

test("flow 4: a warning is shown, does not block, and the question saves", async ({
  context,
  page,
}) => {
  await signUpTeacher(context, "Question Author");
  const crashes = watchForCrashes(page);

  const seed = stamp();
  await page.goto("/teacher/questions/new/");

  // "All of the above" is advice, not a defect: an author may know better than
  // a heuristic, and a rule that fires on good questions gets ignored on bad
  // ones. So it is said, and nothing is disabled.
  await fillMcq(
    page,
    `Which criterion proves the triangles similar? (${seed})`,
    "All of the above",
  );

  await expect(
    page.getByText(/tests reading strategy more than the subject/),
  ).toBeVisible();
  await expect(page.getByText("Consider").first()).toBeVisible();
  await expect(page.getByText("Warnings do not stop you saving.")).toBeVisible();

  // No "Must fix" anywhere: a warning must never be dressed as an error.
  await expect(page.getByText("Must fix")).toHaveCount(0);

  const save = page.getByRole("button", { name: "Save as draft" });
  await expect(save).toBeEnabled();
  await save.click();

  // It really did save, as a DRAFT — generation and typing land in the same
  // place behind the same gate.
  await page.waitForURL(/\/teacher\/questions\/[0-9a-f-]{36}\/?$/);
  await expect(
    page.getByRole("heading", { name: new RegExp(`\\(${seed}\\)`) }),
  ).toBeVisible();
  await expect(page.getByText("Draft").first()).toBeVisible();

  expect(crashes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Flow 5 — generation with no provider configured
// ---------------------------------------------------------------------------

test("flow 5: with no provider configured, generation fails honestly and leaks nothing", async ({
  context,
  page,
}) => {
  await signUpTeacher(context, "Generator");
  const crashes = watchForCrashes(page);

  await page.goto("/teacher/questions/generate/");

  // The page itself has to be honest before anything is pressed: nothing here
  // can put a question in front of a student.
  await expect(
    page.getByText("Everything generated arrives as a draft"),
  ).toBeVisible();

  await page.getByLabel("How many").selectOption("2");
  await page.getByRole("button", { name: "Generate drafts" }).click();

  // There is no API key in this environment, so the gateway falls back to the
  // mock provider, which answers "nothing scripted". What the teacher must get
  // is a sentence saying what happened and what to do — never the provider's
  // own words, which are true and useless to somebody who pressed a button.
  // Not "try again in a moment": with no key it fails the same way on every
  // press, so the sentence says the feature is not switched on here.
  const message =
    "AI generation is not set up on this deployment, so nothing was generated and nothing was saved. Ask whoever runs Sahayak for your school to switch it on.";
  await expect(page.getByText(message)).toBeVisible({ timeout: 60_000 });
  // And it is announced, not merely printed — a failure a teacher has to
  // notice for themselves is one they will read as the page hanging.
  await expect(
    page.getByRole("alert").filter({ hasText: message }),
  ).toHaveCount(1);

  // Nothing from the provider, the SDK or the environment reached the page.
  const rendered = await page.locator("body").innerText();
  for (const leak of [
    "MockProvider",
    "nothing scripted",
    "ANTHROPIC_API_KEY",
    "anthropic",
    "Error:",
    "undefined",
  ]) {
    expect(rendered, `the page leaked ${leak}`).not.toContain(leak);
  }

  // And it must not claim a result it does not have. No drafts, no cost line,
  // no "0 drafts saved" card pretending the run happened.
  await expect(page.getByText(/drafts? saved/)).toHaveCount(0);
  await expect(page.getByText("Nothing made it through")).toHaveCount(0);
  await expect(page.getByText(/This run cost about/)).toHaveCount(0);

  // The form survives, so a teacher can try again without reloading.
  await expect(
    page.getByRole("button", { name: "Generate drafts" }),
  ).toBeEnabled();

  expect(crashes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Flow 6 — the six-step builder
// ---------------------------------------------------------------------------

test("flow 6: the builder walks six steps and names the bank's shortfall at step 3, not step 5", async ({
  context,
  page,
}) => {
  const world = await makeWorld(context);
  const crashes = watchForCrashes(page);

  // The shell is created through the API for the same reason the harness
  // exists: choosing a year and a subject is not what step 3 is being measured
  // on, and the six steps are the flow under test. 20 marks, so the default
  // blueprint asks for 20 questions against a bank that holds two.
  const created = await context.request.post("/api/assessments/", {
    data: {
      title: `E2E builder ${stamp()}`,
      subjectId: world.subjectId,
      gradeId: world.gradeId,
      durationMinutes: 30,
      totalMarks: 20,
    },
  });
  expect(created.ok()).toBe(true);
  const assessmentId = (await created.json()).id as string;

  await page.goto(`/teacher/assessments/${assessmentId}/`);

  const steps = page.getByRole("list", { name: "Builder steps" });
  await expect(steps).toBeVisible();

  // ---- Step 1, Basics ------------------------------------------------------
  await expect(
    page.getByRole("button", { name: /Basics/ }),
  ).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("heading", { name: "Basics" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // ---- Step 2, Curriculum --------------------------------------------------
  //
  // Scoping the paper to the outcome the bank's questions are mapped to. This
  // is the step that makes results say which concepts the class has secured,
  // rather than only who scored what — and it is what the feasibility check
  // one step later counts against.
  await expect(
    page.getByRole("heading", { name: "What does this cover?" }),
  ).toBeVisible();

  const picker = (await (
    await context.request.get("/api/curriculum/picker/")
  ).json()) as { outcomes: { id: string; label: string }[] };
  const outcomeLabel = picker.outcomes.find(
    (outcome) => outcome.id === world.outcomeId,
  )?.label;
  expect(outcomeLabel).toBeTruthy();

  await page.getByRole("checkbox", { name: outcomeLabel! }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // ---- Step 3, Blueprint — where feasibility is answered --------------------
  //
  // The product answers "can your bank fill this?" here, while the mix is
  // still being chosen. Told now it is a decision; discovered at step 5 it is
  // a wasted evening. So the assertion is as much about WHERE the answer
  // appears as about what it says.
  await expect(
    page.getByRole("button", { name: /Blueprint/ }),
  ).toHaveAttribute("aria-current", "step");

  await expect(
    page.getByRole("heading", { name: "Can your bank fill this?" }),
  ).toBeVisible();
  await expect(page.getByText(/The bank can supply/)).toBeVisible();

  // It NAMES the gap — how many, of what difficulty, of what type — rather
  // than reporting that something is short.
  await expect(
    page
      .getByText(
        /You asked for \d+ (easy|medium|hard) multiple-choice questions?/,
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Short").first()).toBeVisible();

  // Shrink the paper to what the bank actually holds. The feasibility answer
  // follows the mix, so the teacher can settle it here rather than later.
  await page.getByLabel("Questions", { exact: true }).fill("2");
  await page.getByLabel("Total marks").fill("2");
  await expect(
    page.getByText(/You asked for \d+ (easy|medium|hard) multiple-choice/),
  ).toHaveCount(0, { timeout: 15_000 });

  await page.getByRole("button", { name: "Continue" }).click();

  // ---- Step 4, Questions ---------------------------------------------------
  await expect(
    page.getByRole("heading", { name: "Choose the questions" }),
  ).toBeVisible();
  const choices = page.getByRole("checkbox");
  await expect(choices).toHaveCount(world.questionIds.length);
  for (let index = 0; index < world.questionIds.length; index++) {
    await choices.nth(index).check();
  }
  await page.getByRole("button", { name: "Save and review" }).click();

  // ---- Step 5, Review ------------------------------------------------------
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(page.getByText("2 questions · 2 of 2 marks")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // ---- Step 6, Publish -----------------------------------------------------
  await expect(page.getByRole("heading", { name: "Publish" })).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  // Publishing freezes the served version of every question, which is what
  // makes a paper sat in August still explainable in December.
  await expect(page.getByText("Published").first()).toBeVisible();
  await expect(page.getByText(/question versions are frozen/)).toBeVisible();

  expect(crashes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Flow 7 — publishing and assigning
// ---------------------------------------------------------------------------

test("flow 7: a window shorter than the paper is refused in the browser, before Assign is ever pressed", async ({
  context,
  page,
}) => {
  const world = await makeWorld(context);
  const crashes = watchForCrashes(page);

  // A two-hour paper made of the world's two approved questions. The duration
  // is what the window is measured against, so it is the number that has to be
  // deliberate here.
  const created = await context.request.post("/api/assessments/", {
    data: {
      title: `E2E assign ${stamp()}`,
      subjectId: world.subjectId,
      gradeId: world.gradeId,
      durationMinutes: 120,
      totalMarks: world.questionIds.length,
    },
  });
  expect(created.ok()).toBe(true);
  const assessmentId = (await created.json()).id as string;

  const filled = await context.request.put(
    `/api/assessments/${assessmentId}/questions/`,
    { data: { questionIds: world.questionIds } },
  );
  expect(filled.ok()).toBe(true);

  await page.goto(`/teacher/assessments/${assessmentId}/`);

  // Questions are already chosen, so the builder opens at Review. Publishing
  // is the browser half of this flow.
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  // Assigning only becomes possible once the paper is published: a draft has
  // no frozen versions, so what a student saw could never be reconstructed.
  await expect(
    page.getByRole("heading", { name: "Assign this paper" }),
  ).toBeVisible();

  const opens = page.getByLabel("Opens");
  const closes = page.getByLabel("Closes");
  const suggestedOpens = await opens.inputValue();
  const opensAt = new Date(suggestedOpens);

  // Every attempt to create an assignment, so "shown rather than met" can be
  // asserted as a fact about the network and not only about a colour.
  const attempts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/api/assignments")
    ) {
      attempts.push(request.url());
    }
  });

  // ---- The refusal, while typing ------------------------------------------
  //
  // Thirty minutes for a two-hour paper. `validateWindow` runs in the browser
  // and again on the server, and the point of the first copy is that a teacher
  // never presses Assign and meets a refusal they could have been shown. So
  // the assertion is that the message is here AND that the button is dead —
  // no request is ever made.
  await closes.fill(toLocalInput(new Date(opensAt.getTime() + 30 * 60_000)));

  await expect(
    page.getByText(
      "The window is 30 minutes long but the test takes 120. Nobody could finish it.",
    ),
  ).toBeVisible();
  const assign = page.getByRole("button", { name: "Assign", exact: true });
  await expect(assign).toBeDisabled();

  // A window that closed before it was created is the other unrecoverable
  // typo — the class never gets to sit it — and it is caught the same way.
  // Long enough for the paper, and entirely in the past.
  await opens.fill(toLocalInput(new Date(Date.now() - 4 * 3600_000)));
  await closes.fill(toLocalInput(new Date(Date.now() - 3600_000)));
  await expect(page.getByText(/That window has already closed/)).toBeVisible();
  await expect(assign).toBeDisabled();

  // Both refusals were reached without the server being asked anything.
  expect(attempts).toEqual([]);

  // ---- A window the paper fits in -----------------------------------------
  await opens.fill(suggestedOpens);
  await closes.fill(toLocalInput(new Date(opensAt.getTime() + 6 * 3600_000)));
  await expect(
    page.getByText(/Nobody could finish it|already closed/),
  ).toHaveCount(0);
  await expect(assign).toBeEnabled();

  await assign.click();

  await expect(
    page.getByRole("heading", { name: "Assigned once" }),
  ).toBeVisible();
  expect(attempts).toHaveLength(1);
  await expect(page.getByText(world.className).first()).toBeVisible();
  await expect(
    page.getByText(`${world.students.length} students`).first(),
  ).toBeVisible();

  expect(crashes).toEqual([]);
});
