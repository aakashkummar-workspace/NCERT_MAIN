import { test, expect } from "@playwright/test";
import { closeDb, makeWorld, signInStudent } from "./support/harness";
import { expectNoViolations } from "./support/axe";

test.afterAll(async () => {
  await closeDb();
});

test("the harness builds a world and signs both roles in", async ({ browser }) => {
  const teacherContext = await browser.newContext();
  const world = await makeWorld(teacherContext);

  const teacherPage = await teacherContext.newPage();
  await teacherPage.goto("/teacher/classes/");
  await expect(teacherPage.getByText(world.className)).toBeVisible();

  const studentContext = await browser.newContext();
  await signInStudent(studentContext, world.students[0]!.phone);
  const studentPage = await studentContext.newPage();
  await studentPage.goto("/student/");
  // The paper's own card, by its heading: the dashboard's "Up next" card names
  // the same paper ("Sit E2E paper …"), so a bare text match finds both.
  await expect(studentPage.getByRole("heading", { name: /E2E paper/ })).toBeVisible();

  await expectNoViolations(studentPage, "/student");

  await teacherContext.close();
  await studentContext.close();
});
