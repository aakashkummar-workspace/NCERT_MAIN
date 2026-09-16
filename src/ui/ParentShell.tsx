import Link from "next/link";
import type { ReactNode } from "react";
import { BrandLockup } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The parent shell.
 *
 * One bar, like the student's, and for the same reason: a parent opens this on
 * a phone, a few times a term, to answer one question — how is my child doing.
 * A navigation rail would list places that do not exist for them.
 *
 * The child switcher lives here rather than on each page, because "which child
 * am I looking at" is the one piece of state that has to survive moving between
 * pages, and a parent of two who has to re-pick on every screen stops using it.
 * A parent with one child sees no switcher at all — a control with one option
 * is a control that teaches somebody the product is more complicated than it is.
 */
export function ParentShell({
  fullName,
  organizationName,
  children,
  switcher,
}: {
  fullName: string;
  organizationName: string;
  children: ReactNode;
  switcher?: ReactNode;
}) {
  return (
    <div className="ui-student">
      <a href="#main" className="sr-only">
        Skip to main content
      </a>

      <header className="ui-student-bar">
        <Link href="/parent" className="ui-brand" style={{ padding: 0 }}>
          <BrandLockup organizationName={organizationName} />
        </Link>

        <div className="ui-student-bar-end">
          {switcher}
          <ThemeToggle />
          <span className="ui-student-name">{fullName}</span>
          <form action="/api/auth/signout/" method="post">
            <button type="submit" className="ui-link-button">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main id="main" className="ui-student-main">
        {children}
      </main>
    </div>
  );
}
