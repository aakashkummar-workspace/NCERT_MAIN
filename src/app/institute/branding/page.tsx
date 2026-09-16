import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { editorState } from "@/core/branding";
import { PageHeader } from "@/ui";
import { BrandingEditor } from "./BrandingEditor";

export const metadata: Metadata = { title: "Branding" };

export const dynamic = "force-dynamic";

/**
 * Branding: the school's name, logo, colours and letterhead.
 *
 * The role and console gates are the layout's. This page adds the one the
 * layout does not know about — `white_label` — and answers it the same way the
 * console answers `admin_console`: a 404, never an upsell.
 */
export default async function BrandingPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const state = await editorState(session.actor.organizationId);
  if (!state || !state.entitled) notFound();

  return (
    <>
      <PageHeader
        title="Branding"
        description="Your school's name, logo and colours on every screen your teachers, students and parents use, and your letterhead on printed reports."
      />
      <BrandingEditor initial={state} />
    </>
  );
}
