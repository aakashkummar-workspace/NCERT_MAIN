"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whose name is on the chrome.
 *
 * ---------------------------------------------------------------------------
 * A context, because the shells may not fetch and fifty pages render them
 * ---------------------------------------------------------------------------
 * `src/ui` may not import `@/core`, and every page under `/teacher`, `/student` and `/parent`
 * renders its own shell. Threading a brand prop through all of them is fifty
 * edits and one page that forgets — which would show Sahayak's name on one
 * screen of a school's product, the kind of seam a parent notices. So the
 * LAYOUT reads the branding once and provides it, and the lockup reads it
 * here. A page cannot forget to pass what it never had to pass.
 *
 * The shape is declared structurally, like `ReportSheet`'s, and
 * `core/branding` satisfies it.
 */

export type UiBrand = {
  name: string;
  shortName: string;
  tagline: string | null;
  logoUrl: string | null;
  hidePoweredBy: boolean;
};

const BrandContext = createContext<UiBrand | null>(null);

export function BrandProvider({
  brand,
  children,
}: {
  brand: UiBrand | null;
  children: ReactNode;
}) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): UiBrand | null {
  return useContext(BrandContext);
}

/**
 * The square mark: a logo, or letters.
 *
 * The logo is decorative (`alt=""`) because the name is always printed beside
 * it — a screen reader announcing "St. Mary's logo, St. Mary's" says the name
 * twice and nothing else.
 */
export function BrandMark({ brand }: { brand: UiBrand | null }) {
  if (brand?.logoUrl) {
    return (
      // A plain <img>: the source is an authenticated route handler, which
      // next/image would try to fetch server-side without the viewer's cookie.
      // eslint-disable-next-line @next/next/no-img-element
      <img className="ui-brand-logo" src={brand.logoUrl} alt="" />
    );
  }
  return (
    <span className="ui-brand-mark" aria-hidden="true">
      {brand ? brand.shortName : "S"}
    </span>
  );
}

/**
 * The lockup in a bar: mark, name, and one line under it.
 *
 * Unbranded, it is exactly what the shells drew before — Sahayak, and the
 * organization (or the teacher sidebar's badge) beneath. Branded, the school's
 * name leads and the line beneath is its tagline, or the attribution, or
 * nothing when the school has switched the attribution off.
 */
export function BrandLockup({
  organizationName,
  badge,
}: {
  organizationName?: string;
  badge?: string;
}) {
  const brand = useBrand();

  if (!brand) {
    return (
      <>
        <span className="ui-brand-mark" aria-hidden="true">
          S
        </span>
        <span className="ui-brand-text">
          <span className="ui-brand-name">Sahayak</span>
          {badge ? (
            <span className="ui-brand-badge">{badge}</span>
          ) : organizationName ? (
            <span className="ui-brand-org">{organizationName}</span>
          ) : null}
        </span>
      </>
    );
  }

  const subline = brand.tagline ?? (brand.hidePoweredBy ? null : "on Sahayak");
  return (
    <>
      <BrandMark brand={brand} />
      <span className="ui-brand-text">
        <span className="ui-brand-name">{brand.name}</span>
        {subline && <span className="ui-brand-org">{subline}</span>}
      </span>
    </>
  );
}

/**
 * The organization's name as the chrome should print it: the school's display
 * name when branded, the legal name otherwise. The teacher's top bar printed
 * "Shot Centre 1789…" beside a sidebar reading "St. Mary's" until a screenshot
 * caught it.
 */
export function OrganizationName({ fallback }: { fallback: string }) {
  const brand = useBrand();
  return <>{brand ? brand.name : fallback}</>;
}

/** "Powered by Sahayak", unless the school has switched it off. */
export function PoweredBy() {
  const brand = useBrand();
  if (!brand || brand.hidePoweredBy) return null;
  return <p className="ui-powered-by">Powered by Sahayak</p>;
}
