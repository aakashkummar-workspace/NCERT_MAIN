import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/core/identity/context";
import { can } from "@/core/billing/entitlements";
import { WHITE_LABEL } from "@/core/branding";
import { ThemeToggle } from "@/ui/ThemeToggle";
import { BrandLockup } from "@/ui/Brand";
import { BrandedSurface, brandedMetadata } from "@/app/_branding/surface";
import { InstituteNav } from "./InstituteNav";

export const generateMetadata = brandedMetadata;

/**
 * The institute console.
 *
 * ---------------------------------------------------------------------------
 * Two gates, and they refuse differently on purpose
 * ---------------------------------------------------------------------------
 * A TEACHER is redirected to their own workspace: they are a legitimate user in
 * the wrong place, and the useful thing to do is take them somewhere they
 * belong.
 *
 * An organization whose plan does not include `admin_console` gets a 404. Not a
 * 403 and not an upsell — a solo teacher on Free is not a failed institute, and
 * a paywall on a page they have no use for is a page that exists only to make
 * them feel small. Whoever is selling them an institute plan can say so.
 *
 * The entitlement is read through `can()`, so which plans include this is data.
 * There is no plan code in this file.
 */
export default async function InstituteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");
  if (session.actor.role === "STUDENT") redirect("/student");
  if (session.actor.role === "PARENT") redirect("/parent");
  if (session.actor.role === "TEACHER") redirect("/teacher");

  const allowed = await can(session.actor.organizationId, "admin_console");
  if (!allowed.allowed) notFound();

  // The Branding tab is offered only where the plan includes it — the same
  // not-an-upsell rule as the console itself.
  const branding = await can(session.actor.organizationId, WHITE_LABEL);

  return (
    <BrandedSurface organizationId={session.actor.organizationId}>
      <div className="ui-institute">
        <a href="#main" className="sr-only">
          Skip to main content
        </a>

        <header className="ui-institute-bar">
          <Link href="/institute" className="ui-brand" style={{ padding: 0 }}>
            <BrandLockup organizationName={session.organizationName} />
          </Link>

          <InstituteNav branding={branding.allowed} />

          <div className="ui-institute-right">
            <ThemeToggle />
            <Link href="/teacher" className="ui-button" data-variant="ghost" data-size="sm">
              <span>Teaching</span>
            </Link>
            {/* A POST, so a prefetch or a link preview cannot end the session. */}
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
    </BrandedSurface>
  );
}
