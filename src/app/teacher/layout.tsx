import { redirect } from "next/navigation";
import { getSession } from "@/core/identity/context";
import { BrandedSurface, brandedMetadata } from "@/app/_branding/surface";

export const generateMetadata = brandedMetadata;

/**
 * The teacher workspace, gated once.
 *
 * ---------------------------------------------------------------------------
 * Why this is a layout and not nineteen checks
 * ---------------------------------------------------------------------------
 * Every page under `/teacher` used to call `getSession()` and redirect only when
 * there was none — which let any SIGNED-IN user read the teacher surface,
 * students and parents included. The data was still tenant-scoped, so nothing
 * leaked across organisations; what leaked was every other child in the class
 * to anybody with an account in it.
 *
 * Found by the parent portal's smoke check, which asked the obvious question
 * nobody had asked of the nineteen pages that came before it.
 *
 * A layout is the fix rather than a helper each page remembers to call, because
 * page twenty is written by somebody who has not read this comment. `/admin` was
 * built this way from the start; `/teacher`, `/student` and `/parent` now match it.
 *
 * A student or parent is redirected to their own home rather than shown a 404:
 * they are a legitimate user in the wrong place, and the useful thing to do
 * with them is take them somewhere they belong.
 */
export default async function TeacherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");
  if (session.actor.role === "STUDENT") redirect("/student");
  if (session.actor.role === "PARENT") redirect("/parent");

  return (
    <BrandedSurface organizationId={session.actor.organizationId}>{children}</BrandedSurface>
  );
}
