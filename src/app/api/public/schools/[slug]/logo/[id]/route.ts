import { publicLogoFor } from "@/core/branding/public";
import { logoResponse } from "../../../../../_lib/logo";
import { fail } from "../../../../../_lib/respond";

export const runtime = "nodejs";

/**
 * The logo on a school's branded sign-in page, for somebody not signed in.
 *
 * Only the school's CURRENT logo, and only while its plan includes branding.
 * An unknown school, an old logo and an unbranded school are the same 404.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const logo = await publicLogoFor(slug, id);
  if (!logo) return fail("NOT_FOUND", "We could not find that.");
  return logoResponse(logo, "public");
}
