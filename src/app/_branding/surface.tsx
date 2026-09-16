import "server-only";
import { cache, type ReactNode } from "react";
import type { Metadata } from "next";
import { effectiveBranding, type Brand } from "@/core/branding";
import { getSession } from "@/core/identity/context";
import { BrandProvider, type UiBrand } from "@/ui/Brand";
import { BrandStyle } from "@/ui/BrandStyle";

/**
 * Branding for a signed-in surface, read once per request.
 *
 * `cache` because a layout and its `generateMetadata` both want it, and a
 * branded page should not cost four entitlement reads.
 */
export const brandFor = cache((organizationId: string) => effectiveBranding(organizationId));

export function toUiBrand(brand: Brand | null): UiBrand | null {
  if (!brand) return null;
  return {
    name: brand.name,
    shortName: brand.shortName,
    tagline: brand.tagline,
    logoUrl: brand.logoUrl,
    hidePoweredBy: brand.hidePoweredBy,
  };
}

/**
 * The school's theme and name around a surface's pages.
 *
 * Every signed-in layout (`/teacher`, `/student`, `/parent`, `/institute`) wraps its children in this,
 * which is why no page has to know branding exists.
 */
export async function BrandedSurface({
  organizationId,
  children,
}: {
  organizationId: string;
  children: ReactNode;
}) {
  const brand = await brandFor(organizationId);
  return (
    <>
      <BrandStyle css={brand?.css ?? null} />
      <BrandProvider brand={toUiBrand(brand)}>{children}</BrandProvider>
    </>
  );
}

/**
 * The tab title and icon, in the school's name.
 *
 * A layout's title template applies to every page under it, so "Report ·
 * St. Mary's" needs no change to the page that says "Report".
 */
export async function brandedMetadata(): Promise<Metadata> {
  const session = await getSession();
  if (!session) return {};
  const brand = await brandFor(session.actor.organizationId);
  return brandMetadataFor(brand);
}

/**
 * The title for a surface's HOME page — `/teacher`, `/student`, `/parent`, `/institute`.
 *
 * A layout's title template applies to its CHILD segments, not to the page in
 * its own segment, so these four kept "Dashboard · Sahayak" on a branded
 * school while every page under them said the school's name. A smoke check
 * caught it. They ask for the title here instead.
 */
export function brandedPageMetadata(title: string) {
  return async function generateMetadata(): Promise<Metadata> {
    const session = await getSession();
    const brand = session ? await brandFor(session.actor.organizationId) : null;
    if (!brand) return { title };
    return { ...brandMetadataFor(brand), title: { absolute: `${title} · ${brand.name}` } };
  };
}

export function brandMetadataFor(brand: Brand | null): Metadata {
  if (!brand) return {};
  return {
    title: { default: brand.name, template: `%s · ${brand.name}` },
    ...(brand.logoUrl ? { icons: { icon: brand.logoUrl } } : {}),
  };
}
