import "server-only";
import { publicBranding, publicLogo } from "@/db/unscoped";
import { initials, publicLogoUrl, type Brand } from "./index";
import { storedTheme, themeCss } from "./theme";

/**
 * A school's public face, before anybody has signed in.
 *
 * Its own file because it is a pre-tenant read, and the ESLint list of modules
 * allowed to make one is the list somebody reads to find out who can. The rest
 * of `core/branding` works inside `withTenant` and has no business on it.
 *
 * Unknown school, unbranded school and a school whose plan does not include
 * white labelling all answer null, identically. A stranger's URL must not be
 * able to learn which of the three it is.
 */

export type PublicBrand = Brand & { website: string | null; slug: string };

/** A slug is lower-case letters, digits and hyphens; anything else names no school. */
const SLUG = /^[a-z0-9-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function publicBrand(slug: string): Promise<PublicBrand | null> {
  if (!SLUG.test(slug)) return null;
  const row = await publicBranding(slug);
  if (!row) return null;

  const name = row.display_name ?? row.organization_name;
  const theme = storedTheme(row.theme);
  return {
    slug,
    name,
    shortName: row.short_name ?? initials(name),
    tagline: row.tagline,
    logoUrl: row.logo_id ? publicLogoUrl(slug, row.logo_id) : null,
    hidePoweredBy: row.hide_powered_by,
    css: theme ? themeCss(theme) : null,
    website: row.website,
  };
}

/** The current logo of a branded school. Null for anything else. */
export async function publicLogoFor(
  slug: string,
  logoId: string,
): Promise<{ mime: string; bytes: Uint8Array } | null> {
  if (!SLUG.test(slug) || !UUID.test(logoId)) return null;
  return publicLogo(slug, logoId);
}
