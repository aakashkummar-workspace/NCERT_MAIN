import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * axe-core, on a rendered page.
 *
 * DESIGN_SYSTEM.md §9 and TESTING.md §7 both say "axe-core on every page, zero
 * violations". Neither has ever been run — the dependency was installed and the
 * script was wired, and no test existed. This is that check.
 *
 * ---------------------------------------------------------------------------
 * Nothing is disabled to make it pass
 * ---------------------------------------------------------------------------
 * The tempting move on a first run is to exclude the rules that fail. That
 * turns the suite into a record of what somebody was willing to fix on a
 * Tuesday, and a suite like that never catches the regression it exists for.
 *
 * If a violation is genuinely a false positive, it is excluded HERE, by rule
 * id, with the reason written next to it — so the exception is one line in one
 * file that a reviewer can argue with, rather than a flag scattered through
 * fifty call sites.
 */

/**
 * Rules that are switched off, and why.
 *
 * Empty on purpose. A rule earns its place on this list by being wrong about
 * this codebase, in a way somebody has written down.
 */
const DISABLED: { rule: string; because: string }[] = [];

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export type Violation = {
  id: string;
  impact: string | null | undefined;
  help: string;
  nodes: string[];
};

/** Run axe and return what it found, in a shape worth reading in a failure. */
export async function findViolations(page: Page): Promise<Violation[]> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (DISABLED.length > 0) {
    builder = builder.disableRules(DISABLED.map((entry) => entry.rule));
  }
  const results = await builder.analyze();

  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.slice(0, 4).map((node) => node.target.join(" ")),
  }));
}

/**
 * Assert a page is clean, and say exactly what is wrong when it is not.
 *
 * The default axe failure prints a wall of JSON. A reviewer needs the rule, the
 * severity and the element — anything else and the fix starts with ten minutes
 * of reading.
 */
export async function expectNoViolations(page: Page, label: string): Promise<void> {
  const violations = await findViolations(page);
  const report = violations
    .map(
      (violation) =>
        `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node}`).join("\n"),
    )
    .join("\n");

  expect(violations, `${label} has accessibility violations:\n${report}`).toEqual([]);
}
