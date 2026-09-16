"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/institute", label: "Dashboard", exact: true },
  { href: "/institute/teachers", label: "Teachers" },
  { href: "/institute/analytics", label: "Analytics" },
  { href: "/institute/webhooks", label: "Integrations" },
  { href: "/institute/branding", label: "Branding", requires: "branding" as const },
  { href: "/institute/subscription", label: "Subscription" },
];

/**
 * The console's tabs, with the current one marked.
 *
 * `aria-current="page"` carries it for a screen reader and the stylesheet draws
 * it from the same attribute, so the two cannot disagree — and the indicator is
 * an underline as well as a colour, because colour is never the only encoding.
 *
 * On a phone the tabs WRAP rather than scroll. A scrolling strip at 390px
 * showed "Dashboa" and nothing else, and a row a person has to discover can be
 * swiped is a row most people never swipe.
 */
export function InstituteNav({ branding }: { branding: boolean }) {
  const pathname = usePathname() ?? "";
  const path = pathname.replace(/\/$/, "") || "/";

  return (
    <nav className="ui-institute-nav" aria-label="Institute">
      {ITEMS.filter((item) => !("requires" in item) || branding).map((item) => {
        const current = item.exact
          ? path === item.href
          : path === item.href || path.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
