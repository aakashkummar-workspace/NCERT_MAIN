import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { currentPlan } from "@/core/billing/entitlements";
import { instituteKpis } from "@/core/institute/kpis";
import { Badge, Card, PageHeader, StatCard } from "@/ui";

export const metadata: Metadata = { title: "Subscription" };

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = {
  max_classes: "Classes",
  max_students: "Students",
  ai_generations_per_month: "AI generations a month",
  analytics: "Analytics",
  parent_reports: "Parent reports",
  admin_console: "Admin console",
  white_label: "Your own branding",
};

export default async function SubscriptionPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const [plan, kpis] = await Promise.all([
    currentPlan(session.actor.organizationId),
    instituteKpis(session.actor.organizationId),
  ]);

  return (
    <>
      <PageHeader
        title="Subscription"
        description="What the plan includes, and what has been used against it."
      />

      <div className="ui-grid">
        <StatCard label="Students" value={kpis.students} />
        <StatCard label="Teachers" value={kpis.teachers} />
        <StatCard
          label="Students who sat something"
          value={kpis.activeStudents}
          context={`of ${kpis.students}, in ${kpis.windowDays} days`}
        />
      </div>

      <Card title="Your plan" description={plan?.name}>
        {!plan ? (
          <p className="ui-hint">No plan is configured on this deployment.</p>
        ) : (
          <>
            <div className="ui-row" style={{ gap: 10, marginBottom: 14 }}>
              <Badge tone={plan.status === "ACTIVE" ? "success" : "primary"}>
                {plan.status === "TRIALING" ? "Free" : plan.status.toLowerCase()}
              </Badge>
              {plan.pricePaise > 0 && (
                <span className="tabular">
                  ₹{(plan.pricePaise / 100).toFixed(0)} a{" "}
                  {plan.interval.toLowerCase()}
                </span>
              )}
            </div>

            <ul className="ui-entitlements">
              {plan.entitlements.map((entitlement) => {
                const spent =
                  entitlement.limit !== null && entitlement.used >= entitlement.limit;
                return (
                  <li key={entitlement.key} data-spent={spent || undefined}>
                    <span className="ui-entitlement-name">
                      {LABEL[entitlement.key] ?? entitlement.key.replace(/_/g, " ")}
                    </span>
                    <span className="ui-entitlement-value tabular">
                      {/*
                        A null limit is a capability with no count — it is on. A
                        number is a real ceiling, and usage once any is spent.
                      */}
                      {entitlement.limit === null
                        ? "Included"
                        : entitlement.used > 0
                          ? `${entitlement.used} of ${entitlement.limit} used`
                          : entitlement.limit}
                    </span>
                  </li>
                );
              })}
            </ul>

            <p className="ui-hint" style={{ marginTop: 14 }}>
              Monthly counts reset on the first. Invoices and self-service plan
              changes arrive with billing; until then, get in touch and we will
              move you.
            </p>
          </>
        )}
      </Card>
    </>
  );
}
