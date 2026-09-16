import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/core/identity/context";
import { ThemeToggle } from "@/ui/ThemeToggle";

/**
 * The platform console.
 *
 * A non-admin gets a 404, not a 403: a 403 confirms this console exists at
 * this path, and there is no reason to tell someone probing for it.
 *
 * Visually distinct from the teacher workspace on purpose — a cross-tenant
 * surface should never be mistaken for the one that is scoped to a single
 * organization.
 */
export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) notFound();

  return (
    <div className="ui-platform">
      <header className="ui-platform-bar">
        <Link href="/admin" className="ui-platform-mark" style={{ textDecoration: "none" }}>
          PLATFORM
        </Link>
        <nav className="ui-platform-nav" aria-label="Platform">
          <Link href="/admin/curriculum">Curriculum</Link>
          <Link href="/admin/review">Review</Link>
          <Link href="/admin/organizations">Organisations</Link>
          <Link href="/admin/costs">AI costs</Link>
          <Link href="/admin/audit">Audit</Link>
        </nav>
        <span className="ui-platform-warning">
          Changes here apply to every organisation
        </span>
        <div className="ui-platform-right">
          <ThemeToggle />
          <Link href="/teacher" className="ui-button" data-variant="ghost" data-size="sm">
            <span>Back to teaching</span>
          </Link>
          {/*
            A form, not a link: signing out is a POST, and a GET that ends a
            session is one a link preview or a prefetch can press.
          */}
          <form action="/api/auth/signout/" method="post">
            <button type="submit" className="ui-button" data-variant="ghost" data-size="sm">
              <span>Sign out</span>
            </button>
          </form>
        </div>
      </header>
      <main id="main" className="ui-content">
        {children}
      </main>
    </div>
  );
}
