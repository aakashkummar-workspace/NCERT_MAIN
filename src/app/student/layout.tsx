import { redirect } from "next/navigation";
import { getSession } from "@/core/identity/context";
import { LocaleProvider } from "@/i18n/LocaleContext";
import { requestLocale } from "@/i18n/server";
import { BrandedSurface, brandedMetadata } from "@/app/_branding/surface";

export const generateMetadata = brandedMetadata;

/**
 * The student surface, gated once.
 *
 * The pages here already checked the role individually, which worked and was
 * one forgotten line away from not working. Same reasoning as `/teacher/layout.tsx`:
 * the check belongs where a new page inherits it rather than where a new page
 * has to remember it.
 *
 * The test player lives under this layout too and renders its own chrome; a
 * layout that only guards adds nothing to the page it wraps.
 *
 * It also resolves the interface language once, for the same reason: the
 * stored preference on the account first, then the handset's
 * `Accept-Language`, then `en-IN`. The student bar and the language switch
 * read it from context, so a page cannot forget to pass it on.
 */
export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/signin/student");
  if (session.actor.role !== "STUDENT") redirect("/");

  const locale = await requestLocale(session.locale);

  return (
    <LocaleProvider locale={locale}>
      <BrandedSurface organizationId={session.actor.organizationId}>{children}</BrandedSurface>
    </LocaleProvider>
  );
}
