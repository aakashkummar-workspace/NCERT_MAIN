import Link from "next/link";
import type { Metadata } from "next";
import { PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "Platform" };

const PLACES = [
  {
    href: "/admin/curriculum",
    title: "Curriculum",
    body: "Chapters, topics, learning outcomes and the concepts that measure them. Every school reads these.",
  },
  {
    href: "/admin/review",
    title: "Review",
    body: "Draft outcomes and concepts waiting for a subject teacher to approve them.",
  },
  {
    href: "/admin/organizations",
    title: "Organisations",
    body: "Find a school and choose its plan. Until there is a payment provider, this is how a plan changes.",
  },
  {
    href: "/admin/costs",
    title: "AI costs",
    body: "What each organisation's AI use is costing, and how much of it failed.",
  },
  {
    href: "/admin/audit",
    title: "Audit",
    body: "Who changed what, across every organisation — without the before and after values.",
  },
];

/**
 * The platform console's front door.
 *
 * It used to 404, which on a surface that already answers 404 to non-admins
 * reads as "you are not allowed here" to the people who are. The layout has
 * already refused everybody else by the time this renders.
 */
export default function PlatformHome() {
  return (
    <Stack>
      <PageHeader
        title="Platform"
        description="Our own work, done once for every school. Changes here apply to every organisation."
      />
      <ul className="ui-grid" data-cols="auto" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {PLACES.map((place) => (
          <li key={place.href} className="ui-card" style={{ padding: 18 }}>
            <h2 className="ui-section-heading" style={{ marginTop: 0 }}>
              <Link href={place.href}>{place.title}</Link>
            </h2>
            <p className="ui-hint" style={{ margin: 0 }}>
              {place.body}
            </p>
          </li>
        ))}
      </ul>
    </Stack>
  );
}
