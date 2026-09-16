import type { Metadata } from "next";
import { aiCosts } from "@/core/platform/console";
import { PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "AI costs" };

export const dynamic = "force-dynamic";

const rupeesPerDollar = 88;

/** Micros of USD, as a figure an operator can act on. */
function money(micros: number): string {
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(2)}`;
}

export default async function CostsPage() {
  const window = await aiCosts(30);
  const saved = window.uncachedMicros - window.costMicros;

  return (
    <Stack>
      <PageHeader
        eyebrow="Platform"
        title="AI costs"
        description="Every call in the last 30 days, across every organisation — successes and failures alike."
      />

      <div className="ui-grid">
        <div className="ui-stat">
          <span className="ui-stat-label">Spent, 30 days</span>
          <span className="ui-stat-value">{money(window.costMicros)}</span>
          <span className="ui-stat-context">
            about ₹{Math.round((window.costMicros / 1_000_000) * rupeesPerDollar)}
          </span>
        </div>
        <div className="ui-stat">
          <span className="ui-stat-label">Calls</span>
          <span className="ui-stat-value tabular">{window.calls}</span>
          <span className="ui-stat-context">
            {/*
              Failures on the same card as calls, deliberately. A retry storm
              that spends money and produces nothing is invisible in a
              success-only view, and that invisibility is what produces a
              surprise bill.
            */}
            {window.failures} failed or refused
          </span>
        </div>
        <div className="ui-stat">
          <span className="ui-stat-label">Saved by caching</span>
          <span className="ui-stat-value">{money(saved)}</span>
          <span className="ui-stat-context">approximate, across tiers</span>
        </div>
        <div className="ui-stat">
          <span className="ui-stat-label">Cached tokens</span>
          <span className="ui-stat-value tabular">
            {window.inputTokens === 0
              ? "—"
              : `${Math.round((window.cachedInputTokens / window.inputTokens) * 100)}%`}
          </span>
          <span className="ui-stat-context">
            of input. If this reaches zero, a prefix invalidator has shipped.
          </span>
        </div>
      </div>

      {window.calls === 0 ? (
        <p className="ui-hint">
          No AI calls in the last 30 days. With no ANTHROPIC_API_KEY configured
          the gateway runs against a mock, which costs nothing and records
          nothing.
        </p>
      ) : (
        <div className="ui-class-layout" style={{ marginTop: 4 }}>
          <section>
            <h2 className="ui-platform-heading">By organisation</h2>
            <ul className="ui-cost-rows">
              {window.byOrganization.map((row) => (
                <li key={row.organizationId ?? "platform"}>
                  <span className="ui-cost-name">{row.name}</span>
                  <span className="tabular">{row.calls} calls</span>
                  <span className="ui-row-score tabular">{money(row.costMicros)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="ui-platform-heading">By feature</h2>
            <ul className="ui-cost-rows">
              {window.byFeature.map((row) => (
                <li key={row.feature}>
                  <span className="ui-cost-name">{row.feature.toLowerCase().replace(/_/g, " ")}</span>
                  <span className="tabular">{row.calls} calls</span>
                  <span className="ui-row-score tabular">{money(row.costMicros)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Stack>
  );
}
