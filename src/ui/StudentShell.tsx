import Link from "next/link";
import type { ReactNode } from "react";
import { LanguageSwitch } from "@/i18n/LanguageSwitch";
import { T } from "@/i18n/T";
import { BrandLockup } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The student shell.
 *
 * Deliberately not the teacher's sidebar. A student has one job on this
 * product — take the test in front of them — and most of them are on a phone,
 * where a navigation rail costs a third of the screen to list places they do
 * not need. One bar, the name, a way out.
 *
 * The player does not use this shell at all: during a timed paper, every pixel
 * of chrome is a pixel not showing the question.
 *
 * The bar's own words go through the i18n seam, in the locale `/student/layout.tsx`
 * resolved for the signed-in student. `T` and `LanguageSwitch` read it from
 * context, so no page has to remember to pass it — the page that forgets is
 * the one that shows an English bar to a student who chose Hindi.
 *
 * `width="wide"` is for the home dashboard, which has two columns on a desk.
 * Every other student page keeps the reading width, because a question or a
 * result is read line by line and a 1,100px measure is harder to read.
 */
export function StudentShell({
  fullName,
  organizationName,
  width,
  children,
}: {
  fullName: string;
  organizationName: string;
  width?: "wide";
  children: ReactNode;
}) {
  return (
    <div className="ui-student">
      <a href="#main" className="sr-only">
        <T k="student.skip" />
      </a>

      <header className="ui-student-bar">
        <Link href="/student" className="ui-brand" style={{ padding: 0 }}>
          <BrandLockup organizationName={organizationName} />
        </Link>

        <div className="ui-student-bar-end">
          <Link href="/student/practice" className="ui-student-link">
            <T k="student.nav.practice" />
          </Link>
          <Link href="/student/progress" className="ui-student-link">
            <T k="student.nav.progress" />
          </Link>
          <Link href="/student/syllabus" className="ui-student-link">
            <T k="student.nav.syllabus" />
          </Link>
          <LanguageSwitch />
          <ThemeToggle />
          <span className="ui-student-name">{fullName}</span>
          <form action="/api/auth/signout/" method="post">
            <button type="submit" className="ui-link-button">
              <T k="student.signOut" />
            </button>
          </form>
        </div>
      </header>

      <main id="main" className="ui-student-main" data-width={width}>
        {children}
      </main>
    </div>
  );
}
