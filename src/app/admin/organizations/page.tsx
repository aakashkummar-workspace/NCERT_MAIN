import type { Metadata } from "next";
import { listPlans, searchOrganizations, SEARCH_LIMIT } from "@/core/platform/plans";
import { EmptyState, PageHeader, Stack } from "@/ui";
import { PlanPicker } from "./PlanPicker";

export const metadata: Metadata = { title: "Organisations" };
export const dynamic = "force-dynamic";

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const [{ rows, truncated }, plans] = await Promise.all([searchOrganizations(q), listPlans()]);

  return (
    <Stack>
      <PageHeader
        title="Organisations"
        description="Find a school and choose its plan. The change applies at once, is written into the school's own audit log, and is marked as set by hand rather than paid for."
      />

      <form method="get" className="ui-org-search" role="search">
        <label className="ui-label" htmlFor="org-q">
          Search by name or slug
        </label>
        <div className="ui-org-search-row">
          <input id="org-q" name="q" className="ui-input" defaultValue={q} placeholder="e.g. Sirah Digital" />
          <button type="submit" className="ui-button" data-variant="secondary">
            <span>Search</span>
          </button>
        </div>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No organisation matches" body="Try part of the name, or the slug." />
      ) : (
        <>
          <p className="ui-hint" role="status">
            {truncated
              ? `Showing the newest ${SEARCH_LIMIT}. Search to narrow it down.`
              : `${rows.length} ${rows.length === 1 ? "organisation" : "organisations"}`}
          </p>
          <ul className="ui-org-list">
            {rows.map((org) => (
              <li key={org.id}>
                <div className="ui-org-main">
                  <span className="ui-org-name">{org.name}</span>
                  <span className="ui-org-meta">
                    {org.slug} · {org.type.toLowerCase().replace(/_/g, " ")} · since {DATE.format(org.createdAt)}
                  </span>
                </div>
                <PlanPicker
                  organizationId={org.id}
                  organizationName={org.name}
                  current={org.planCode}
                  isFallback={org.isFallback}
                  plans={plans.map((plan) => ({ code: plan.code, name: plan.name }))}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </Stack>
  );
}
