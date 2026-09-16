import Link from "next/link";
import type { ReactNode } from "react";
import { Avatar } from "./index";
import { BrandLockup, OrganizationName, PoweredBy } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The teacher workspace shell: sidebar, top bar, content.
 *
 * Navigation names the slices that do not exist yet and marks them "soon"
 * rather than hiding them or, worse, linking to a blank page. A teacher
 * evaluating the product should be able to see where it is going.
 */

import {
  DashboardIcon,
  ClassesIcon,
  AssessmentsIcon,
  QuestionsIcon,
  StudentsIcon,
  BookOpenIcon,
  AnalyticsIcon,
  SparklesIcon,
  ReportsIcon,
  SettingsIcon,
} from "./icons";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  soon?: boolean;
};

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Teach",
    items: [
      { href: "/teacher", label: "Dashboard", icon: <DashboardIcon size={18} /> },
      { href: "/teacher/classes", label: "My Classes", icon: <ClassesIcon size={18} /> },
      { href: "/teacher/assessments", label: "Assessments", icon: <AssessmentsIcon size={18} /> },
      { href: "/teacher/questions", label: "Question Bank", icon: <QuestionsIcon size={18} /> },
      { href: "/teacher/students", label: "Students", icon: <StudentsIcon size={18} /> },
      { href: "/teacher/syllabus", label: "Syllabus", icon: <BookOpenIcon size={18} /> },
    ],
  },
  {
    section: "Understand",
    items: [
      { href: "/teacher/analytics", label: "Analytics", icon: <AnalyticsIcon size={18} /> },
      { href: "/teacher/copilot", label: "AI Copilot", icon: <SparklesIcon size={18} /> },
      { href: "/teacher/reports", label: "Reports", icon: <ReportsIcon size={18} /> },
    ],
  },
  {
    section: "Account",
    items: [{ href: "/teacher/settings", label: "Settings", icon: <SettingsIcon size={18} /> }],
  },
];

export function AppShell({
  currentPath,
  fullName,
  organizationName,
  breadcrumbs,
  topbarAction,
  children,
}: {
  currentPath: string;
  fullName: string;
  organizationName: string;
  breadcrumbs?: { label: string; href?: string }[];
  topbarAction?: ReactNode | false;
  children: ReactNode;
}) {
  return (
    <div className="ui-shell">
      <a href="#main" className="sr-only">
        Skip to main content
      </a>

      <aside className="ui-sidebar">
        <div>
          <div className="ui-brand">
            <BrandLockup badge="CBSE 9 & 10" />
          </div>

          <nav className="ui-nav" aria-label="Main">
            {NAV.map((group) => (
              <div key={group.section} className="ui-nav-group">
                <div className="ui-nav-section">{group.section}</div>
                {group.items.map((item) =>
                  item.soon ? (
                    <span
                      key={item.href}
                      className="ui-nav-item"
                      data-soon="true"
                      aria-disabled="true"
                    >
                      <span className="ui-nav-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="ui-nav-label">{item.label}</span>
                      <span className="ui-nav-soon">soon</span>
                    </span>
                  ) : (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="ui-nav-item"
                      aria-current={currentPath === item.href ? "page" : undefined}
                    >
                      <span className="ui-nav-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="ui-nav-label">{item.label}</span>
                    </Link>
                  ),
                )}
              </div>
            ))}
          </nav>
        </div>

        <div className="ui-sidebar-footer">
          <div className="ui-sidebar-user">
            <Avatar name={fullName} />
            <div className="ui-sidebar-user-meta">
              <span className="ui-sidebar-user-name">{fullName}</span>
              <span className="ui-sidebar-user-role">
                <OrganizationName fallback={organizationName} />
              </span>
            </div>
          </div>
          <div className="ui-sidebar-footer-actions">
            <ThemeToggle />
            <form action="/api/auth/signout/" method="post">
              <button
                type="submit"
                className="ui-button"
                data-variant="ghost"
                data-size="sm"
                style={{ padding: "0 8px", fontSize: 12, height: 28 }}
              >
                <span>Sign out</span>
              </button>
            </form>
          </div>
          <PoweredBy />
        </div>
      </aside>

      <div className="ui-main">
        <header className="ui-topbar">
          <div className="ui-topbar-breadcrumbs">
            <span className="ui-topbar-crumb-org">
              <OrganizationName fallback={organizationName} />
            </span>
            {breadcrumbs ? (
              breadcrumbs.map((crumb, index) => (
                <span key={index} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span className="ui-topbar-crumb-sep">/</span>
                  {crumb.href ? (
                    <Link href={crumb.href} className="ui-topbar-crumb-link">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="ui-topbar-crumb-active">{crumb.label}</span>
                  )}
                </span>
              ))
            ) : (
              <>
                <span className="ui-topbar-crumb-sep">/</span>
                <span className="ui-topbar-crumb-active">
                  {currentPath.startsWith("/teacher/classes")
                    ? "Classes"
                    : currentPath.startsWith("/teacher/assessments")
                      ? "Assessments"
                      : currentPath.startsWith("/teacher/questions")
                        ? "Question Bank"
                        : currentPath.startsWith("/teacher/students")
                          ? "Students"
                          : currentPath.startsWith("/teacher/analytics")
                            ? "Analytics"
                            : currentPath.startsWith("/teacher/copilot")
                              ? "AI Copilot"
                              : currentPath.startsWith("/teacher/reports")
                                ? "Reports"
                                : "Dashboard"}
                </span>
              </>
            )}
          </div>

          <div className="ui-topbar-right">
            {topbarAction !== false &&
              (topbarAction || (
                <Link
                  href="/teacher/assessments/new"
                  className="ui-button"
                  data-variant="primary"
                  data-size="sm"
                >
                  <span>+ New assessment</span>
                </Link>
              ))}
          </div>
        </header>

        <main id="main" className="ui-content">
          {children}
        </main>
      </div>
    </div>
  );
}
