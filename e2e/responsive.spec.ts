import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  closeDb,
  grantFullPlan,
  makeWorld,
  phoneFor,
  signInStudent,
  stamp,
  type World,
} from "./support/harness";

/**
 * Tap targets and layout, on real screens.
 *
 * ---------------------------------------------------------------------------
 * The check both documents promise and neither has ever run
 * ---------------------------------------------------------------------------
 * DESIGN_SYSTEM.md §6: "Minimum tap target 44×44px, enforced by an automated
 * check in CI, not by inspection." §14: "Target size ≥ 44×44px, checked in CI."
 * TESTING.md §7: "Tap targets: ≥ 44×44px, Playwright over every interactive
 * element on mobile viewports."
 *
 * There has never been such a check. This is it, and it is written expecting to
 * fail: the bugs CLAUDE.md already records under "Design" — a destructive
 * button wrapping under the wrong student's name, four stat cards laid out as
 * four full-width blocks by a bare `.ui-grid`, a `.ui-button` with no padding
 * and no height because a `data-size` was forgotten — are all this class of
 * bug, and all of them were found by a person looking at a screenshot.
 *
 * Nothing here is relaxed to get green. 44 is the number both documents commit
 * to; a suite that lowered it to 40 to pass would be a record of what the
 * product does rather than what it promises.
 *
 * ---------------------------------------------------------------------------
 * Two questions, at four widths
 * ---------------------------------------------------------------------------
 * 1. At 390px — the width playwright.config.ts calls "the one a student is
 *    actually holding" — is every control at least 44×44?
 * 2. At 360, 768 and 1440 — IMPLEMENTATION_PLAN.md's Definition of Done — does
 *    the page body scroll sideways? 360 is the important one: it is narrower
 *    than the mobile project, and it is the width of the cheapest Android phone
 *    a Class 9 student is likely to own.
 *
 * The design system's rule is that wide content (a mastery heatmap, a results
 * table) scrolls inside its OWN container. So an element wider than the
 * viewport is only reported when nothing between it and the document clips or
 * scrolls — a table inside `overflow-x: auto` is doing the right thing and is
 * not a finding.
 *
 * ---------------------------------------------------------------------------
 * One test per screen, per width
 * ---------------------------------------------------------------------------
 * A single test walking twelve screens stops at the first one that fails, and
 * the output is then a fix list with one item on it. Each screen gets its own
 * test case with its name in the title, and each tap-target failure inside one
 * screen is collected before the assertion — so one bad button does not hide
 * the other five on the same page.
 */

/**
 * The file sets its own viewport in every test, so running it under both
 * projects would measure the same four widths twice. It belongs to `mobile`,
 * which playwright.config.ts already points at this file by name.
 */
const PROJECT = "mobile";

/** DESIGN_SYSTEM.md §6 and §14, TESTING.md §7. Not negotiable downward. */
const MIN_TAP = 44;

/** The mobile project's viewport — the width the design system is checked at. */
const TAP_VIEWPORT = { width: 390, height: 844 };

/** IMPLEMENTATION_PLAN.md's Definition of Done: "Responsive at 360 / 768 / 1440". */
const WIDTHS = [360, 768, 1440] as const;

/** Sub-pixel layout is normal; a 0.5px overhang is not a horizontal scrollbar. */
const ROUNDING_SLACK = 1;

// ---------------------------------------------------------------------------
// What counts as a tap target, and what deliberately does not
// ---------------------------------------------------------------------------
//
// INCLUDED — `button`, `a[href]`, `input`, `select`, `[role=button]`,
// `[role=tab]`, when visible. These are the controls a finger has to land on.
//
// EXCLUDED, each for a reason:
//
//   * Anything screen-reader-only. The skip link in every shell is 1×1 and
//     clipped until it takes focus; measuring it would report a 1×1 failure on
//     all twelve screens and teach everybody to ignore the list.
//
//   * `a` with no `href`. Not interactive, not focusable, not a target.
//
//   * An inline link inside running text. This is WCAG 2.5.8's own exception,
//     implemented rather than asserted: the link's display is `inline` AND its
//     nearest block ancestor holds meaningfully more text than the link does,
//     i.e. it sits in a sentence. "Read the marking guide" mid-paragraph is
//     prose. A nav item, a breadcrumb, anything laid out by flex or grid (the
//     browser blockifies those, so their computed display is not `inline`),
//     and anything inside `nav`/`header`/`footer` is a control and is measured.
//
// MEASURED GENEROUSLY, so the list stays a fix list:
//
//   * A checkbox or radio is measured over its `<label>` as well as itself.
//     The box is 16px in every browser; the thing a finger hits is the label,
//     and reporting the box would be a false positive on every form in the
//     product.
//
// Disabled controls ARE measured. A disabled button becomes enabled, occupies
// the same box when it does, and is not a special case worth an exception.
const CONTROLS = 'button, a[href], input, select, [role="button"], [role="tab"]';

type Target = { label: string; width: number; height: number };
type Overflowing = { label: string; left: number; right: number };
type Audit = {
  targets: Target[];
  scanned: number;
  scrollWidth: number;
  clientWidth: number;
  overflowing: Overflowing[];
};

/**
 * Measure everything on the rendered page, in one round trip.
 *
 * Both questions are answered from the same DOM walk: asking Playwright for
 * each element's box one at a time is a round trip per control, and the
 * teacher's question bank has enough of them for that to matter.
 */
async function audit(page: Page, selector: string): Promise<Audit> {
  return page.evaluate((controls: string) => {
    const describe = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type");
      const role = el.getAttribute("role");
      const id = el.id ? `#${el.id}` : "";
      const classes =
        typeof el.className === "string" && el.className.trim().length > 0
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "";
      const text = (
        el.getAttribute("aria-label") ??
        el.textContent ??
        el.getAttribute("value") ??
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 44);
      return (
        `${tag}${type ? `[type=${type}]` : ""}${role ? `[role=${role}]` : ""}` +
        `${id}${classes}${text ? ` "${text}"` : ""}`
      );
    };

    /** Clipped to nothing until it is focused — the skip link in every shell. */
    const screenReaderOnly = (el: Element): boolean => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (node.classList.contains("sr-only")) return true;
        if (window.getComputedStyle(node).clipPath === "inset(50%)") return true;
      }
      return false;
    };

    const visible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    /** WCAG 2.5.8's inline exception: a link sitting inside a sentence. */
    const inlineProseLink = (el: Element): boolean => {
      if (el.tagName !== "A") return false;
      if (window.getComputedStyle(el).display !== "inline") return false;
      if (el.closest('nav, header, footer, [role="navigation"], [role="tablist"]')) {
        return false;
      }
      let block: Element | null = el.parentElement;
      while (block && window.getComputedStyle(block).display.startsWith("inline")) {
        block = block.parentElement;
      }
      if (!block) return false;
      const own = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const all = (block.textContent ?? "").replace(/\s+/g, " ").trim();
      // A dozen characters of surrounding prose, not one stray word.
      return all.length >= own.length + 12;
    };

    /** The box a finger actually has to hit. */
    const hitBox = (el: Element): { width: number; height: number } => {
      const rect = el.getBoundingClientRect();
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) {
        const label =
          el.closest("label") ??
          (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
        if (label) {
          const other = label.getBoundingClientRect();
          return {
            width: Math.max(rect.right, other.right) - Math.min(rect.left, other.left),
            height: Math.max(rect.bottom, other.bottom) - Math.min(rect.top, other.top),
          };
        }
      }
      return { width: rect.width, height: rect.height };
    };

    const targets: { label: string; width: number; height: number }[] = [];
    for (const el of Array.from(document.querySelectorAll(controls))) {
      if (!visible(el)) continue;
      if (screenReaderOnly(el)) continue;
      if (inlineProseLink(el)) continue;
      const box = hitBox(el);
      targets.push({
        label: describe(el),
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
      });
    }

    // --- What is pushing the page sideways -----------------------------------
    //
    // An element wider than the viewport is only a finding when nothing between
    // it and the document scrolls or clips. A results table inside
    // `overflow-x: auto` is the design system's own rule being followed.
    const doc = document.documentElement;
    const limit = doc.clientWidth;
    const overflowing: { label: string; left: number; right: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const style = window.getComputedStyle(el);
      // Fixed elements are outside the document's scroll box entirely.
      if (style.position === "fixed" || style.display === "none") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right <= limit + 1 && rect.left >= -1) continue;

      let contained = false;
      for (let node = el.parentElement; node && node !== doc; node = node.parentElement) {
        const overflowX = window.getComputedStyle(node).overflowX;
        if (
          overflowX === "auto" ||
          overflowX === "scroll" ||
          overflowX === "hidden" ||
          overflowX === "clip"
        ) {
          contained = true;
          break;
        }
      }
      if (contained) continue;

      overflowing.push({
        label: describe(el),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      });
    }

    return {
      targets,
      scanned: targets.length,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowing: overflowing.slice(0, 8),
    };
  }, selector);
}

// ---------------------------------------------------------------------------
// The world these screens are looked at through
// ---------------------------------------------------------------------------

type Role = "student" | "teacher" | "parent";

type Screen = { name: string; role: Role; path: () => string };

let world: World | null = null;
let teacherContext: BrowserContext | null = null;
let studentContext: BrowserContext | null = null;
let parentContext: BrowserContext | null = null;
let openAttemptId = "";

/** Why a role could not be reached, kept so a test reports it rather than crashing. */
const unreachable = new Map<Role, string>();

/**
 * A direct connection, for the one thing the browser cannot do.
 *
 * A parent has no account until they accept, so `signInStudent` cannot issue
 * their code — `app_auth_consume_code` returns nothing when no user exists,
 * which is exactly why `app_auth_verify_code` is a separate pre-tenant read.
 * The production build returns no `devCode` either, so the code is issued here
 * the same way the harness does it.
 */
let sql: pg.Client | null = null;
async function directDb(): Promise<pg.Client> {
  if (sql) return sql;
  const next = new pg.Client({ connectionString: process.env.DIRECT_URL });
  await next.connect();
  sql = next;
  return next;
}

/** Sit the paper, badly, so there is evidence, a mistake and a mastery figure. */
async function sitBadly(context: BrowserContext, assignmentId: string): Promise<void> {
  const started = await context.request.post("/api/attempts/", {
    data: { assignmentId, clientAttemptId: randomUUID() },
  });
  const { attemptId } = (await started.json()) as { attemptId: string };
  const player = (await (
    await context.request.get(`/api/attempts/${attemptId}/`)
  ).json()) as { questions: { assessmentQuestionId: string }[] };

  await context.request.patch(`/api/attempts/${attemptId}/answers/`, {
    data: {
      answers: player.questions.map((question) => ({
        assessmentQuestionId: question.assessmentQuestionId,
        response: { kind: "choice", keys: ["B"] },
        clientSeq: 1,
      })),
    },
  });
  await context.request.post(`/api/attempts/${attemptId}/submit/`, {
    data: { reason: "MANUAL" },
  });
}

const SCREENS: Screen[] = [
  { name: "student home", role: "student", path: () => "/student/" },
  { name: "student practice", role: "student", path: () => "/student/practice/" },
  { name: "student plan", role: "student", path: () => "/student/plan/" },
  { name: "student readiness", role: "student", path: () => "/student/readiness/" },
  { name: "student mistakes", role: "student", path: () => "/student/mistakes/" },
  { name: "test player", role: "student", path: () => `/student/attempt/${openAttemptId}/` },
  { name: "teacher dashboard", role: "teacher", path: () => "/teacher/" },
  { name: "teacher classes", role: "teacher", path: () => "/teacher/classes/" },
  {
    name: "teacher class detail",
    role: "teacher",
    path: () => `/teacher/classes/${world?.classId ?? ""}/`,
  },
  {
    // The series page carries a destructive control ("Take out") beside the
    // name of an exam, which is exactly the row this suite exists to watch at
    // 360px: a wrap that puts it under the wrong paper's name.
    name: "teacher exam series",
    role: "teacher",
    path: () => `/teacher/series/${world?.seriesId ?? ""}/`,
  },
  { name: "teacher questions", role: "teacher", path: () => "/teacher/questions/" },
  { name: "teacher analytics", role: "teacher", path: () => "/teacher/analytics/" },
  {
    // Not on the brief, but the mastery heatmap is the one grid in the product
    // most likely to push the body sideways, which is the whole second half of
    // this suite.
    name: "teacher class analytics",
    role: "teacher",
    path: () => `/teacher/analytics/${world?.classId ?? ""}/`,
  },
  { name: "parent portal home", role: "parent", path: () => "/parent/" },
];

function contextFor(role: Role): BrowserContext {
  const why = unreachable.get(role);
  if (why) throw new Error(`the ${role} surface could not be reached: ${why}`);
  const context =
    role === "student" ? studentContext : role === "teacher" ? teacherContext : parentContext;
  if (!context) throw new Error(`no ${role} context — setup did not run`);
  return context;
}

/**
 * Open a screen and prove it is the screen.
 *
 * A signed-out redirect to `/signin` would otherwise let a page "pass" both
 * checks by not being the page: the sign-in form is two inputs and a button and
 * has never scrolled sideways in its life.
 */
async function open(page: Page, path: string, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  const response = await page.goto(path, { waitUntil: "load" });
  await page.waitForLoadState("networkidle").catch(() => {});

  expect(response, `${path} returned no response`).not.toBeNull();
  expect(
    response!.status(),
    `${path} returned HTTP ${response!.status()} — the screen was not reachable`,
  ).toBeLessThan(400);

  const landed = new URL(page.url()).pathname;
  expect(landed, `${path} redirected to ${landed} — this is not the screen`).toBe(path);
}

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.name !== PROJECT) return;
  test.setTimeout(240_000);

  teacherContext = await browser.newContext();
  world = await makeWorld(teacherContext, { questionCount: 4, maxAttempts: 4 });
  await grantFullPlan(world.teacher.organizationId);

  const student = world.students[0]!;
  studentContext = await browser.newContext();
  await signInStudent(studentContext, student.phone);

  // Two full sittings, wrong throughout: eight pieces of evidence on one
  // concept, which clears the mastery threshold, produces a recommendation for
  // /student/practice, an item for /student/plan and cards for /student/mistakes. A screen whose
  // empty state is all that renders is a screen this suite has not looked at.
  await sitBadly(studentContext, world.assignmentId);
  await sitBadly(studentContext, world.assignmentId);

  // And one left open, because the player is only the player mid-paper.
  const started = await studentContext.request.post("/api/attempts/", {
    data: { assignmentId: world.assignmentId, clientAttemptId: randomUUID() },
  });
  openAttemptId = ((await started.json()) as { attemptId: string }).attemptId;

  // --- The parent, who has no account until they accept --------------------
  try {
    const parentPhone = phoneFor(stamp());
    const invited = await teacherContext.request.post(
      `/api/students/${student.userId}/parents/`,
      { data: { phone: parentPhone, relationship: "MOTHER" } },
    );
    if (!invited.ok()) {
      throw new Error(`invite returned ${invited.status()} ${await invited.text()}`);
    }
    const { token } = (await invited.json()) as { token: string };

    const code = "246813";
    const db = await directDb();
    await db.query("delete from login_codes where phone = $1", [parentPhone]);
    await db.query("select app_auth_issue_code($1, $2, $3)", [
      parentPhone,
      createHash("sha256").update(`${parentPhone}:${code}`, "utf8").digest(),
      new Date(Date.now() + 5 * 60_000),
    ]);

    parentContext = await browser.newContext();
    const accepted = await parentContext.request.post("/api/parent/accept/", {
      data: { token, phone: parentPhone, code, fullName: "E2E Parent" },
    });
    if (!accepted.ok()) {
      throw new Error(`accept returned ${accepted.status()} ${await accepted.text()}`);
    }
  } catch (error) {
    unreachable.set("parent", error instanceof Error ? error.message : String(error));
  }
});

test.afterAll(async () => {
  await teacherContext?.close();
  await studentContext?.close();
  await parentContext?.close();
  if (sql) {
    await sql.end();
    sql = null;
  }
  await closeDb();
});

// Playwright insists on the destructuring form for the fixtures argument, even
// when no fixture is wanted.
test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== PROJECT,
    "measured at explicit viewports, so it runs once — in the mobile project",
  );
});

// ---------------------------------------------------------------------------
// 1. Tap targets at 390px
// ---------------------------------------------------------------------------

test.describe("tap targets are at least 44x44 at 390px", () => {
  for (const screen of SCREENS) {
    test(`${screen.name} — every control is 44x44 or larger`, async () => {
      const page = await contextFor(screen.role).newPage();
      try {
        await open(page, screen.path(), TAP_VIEWPORT.width, TAP_VIEWPORT.height);
        const result = await audit(page, CONTROLS);

        expect(
          result.scanned,
          `${screen.name} has no interactive controls at all, which means this ` +
            `test is measuring nothing — check the screen rendered`,
        ).toBeGreaterThan(0);

        const failures = result.targets.filter(
          (target) => target.width < MIN_TAP || target.height < MIN_TAP,
        );

        const report = failures
          .map(
            (target) =>
              `    ${target.label.padEnd(72)} ${target.width} × ${target.height}`,
          )
          .join("\n");

        expect(
          failures.length,
          `${screen.name} at ${TAP_VIEWPORT.width}px: ${failures.length} of ` +
            `${result.scanned} controls are smaller than ${MIN_TAP}×${MIN_TAP}\n` +
            `${report}\n` +
            `  (DESIGN_SYSTEM.md §6 and §14, TESTING.md §7)`,
        ).toBe(0);
      } finally {
        await page.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The page body never scrolls sideways
// ---------------------------------------------------------------------------

test.describe("the page body does not scroll horizontally", () => {
  for (const screen of SCREENS) {
    for (const width of WIDTHS) {
      test(`${screen.name} — no horizontal scroll at ${width}px`, async () => {
        const page = await contextFor(screen.role).newPage();
        try {
          await open(page, screen.path(), width, 900);
          const result = await audit(page, CONTROLS);

          const culprits = result.overflowing
            .map(
              (element) =>
                `    ${element.label.padEnd(72)} spans ${element.left}…${element.right}`,
            )
            .join("\n");

          expect(
            result.scrollWidth,
            `${screen.name} at ${width}px scrolls sideways: document scrollWidth ` +
              `${result.scrollWidth} against clientWidth ${result.clientWidth}.\n` +
              `  Widest things not inside a container that scrolls on its own:\n` +
              `${culprits || "    (nothing single element — check a min-width or a fixed width)"}\n` +
              `  (DESIGN_SYSTEM.md §6: wide content scrolls inside its OWN container)`,
          ).toBeLessThanOrEqual(result.clientWidth + ROUNDING_SLACK);
        } finally {
          await page.close();
        }
      });
    }
  }
});
