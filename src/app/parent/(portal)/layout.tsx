import { redirect } from "next/navigation";
import { getSession } from "@/core/identity/context";
import { BrandedSurface, brandedMetadata } from "@/app/_branding/surface";

export const generateMetadata = brandedMetadata;

/**
 * The parent portal, gated once.
 *
 * ---------------------------------------------------------------------------
 * Why this is a route group
 * ---------------------------------------------------------------------------
 * `/parent/link/[token]` has to be reachable with no session at all — the person
 * opening an invitation does not have an account yet, and that is the point of
 * the page. A guard on `/parent/layout.tsx` would have locked out exactly the people
 * it exists for.
 *
 * So the authenticated portal lives in a `(portal)` group with the guard, and
 * the invitation page sits outside it. The group does not appear in the URL:
 * this still serves `/parent`.
 *
 * Being a PARENT gets somebody through this door and no further. Which children
 * they can see is a question only `core/parent/read.ts` answers, from consented
 * links, one child at a time.
 */
export default async function ParentPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "PARENT") redirect("/");

  return (
    <BrandedSurface organizationId={session.actor.organizationId}>{children}</BrandedSurface>
  );
}
