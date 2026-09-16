import type { Metadata } from "next";
import { auditActions, searchAudit } from "@/core/platform/console";
import { PageHeader, Stack } from "@/ui";

export const metadata: Metadata = { title: "Audit" };

export const dynamic = "force-dynamic";

/**
 * Audit search.
 *
 * Filters in the query string, so a link to a search is a link somebody can
 * paste into an incident channel. No free text: an audit log is searched by
 * who, what and when, and a text query over this table is a scan somebody runs
 * at the worst possible moment.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entityType?: string; days?: string }>;
}) {
  const params = await searchParams;
  const requested = Number(params.days ?? 7);
  const days = Number.isFinite(requested) ? requested : 7;

  const [rows, actions] = await Promise.all([
    searchAudit({
      action: params.action || undefined,
      entityType: params.entityType || undefined,
      withinDays: days,
      limit: 200,
    }),
    auditActions(),
  ]);

  return (
    <Stack>
      <PageHeader
        eyebrow="Platform"
        title="Audit"
        description="Who did what, across every organisation. Append-only by database trigger — nothing here, and nobody, can edit or delete a row."
      />

      <form className="ui-audit-filters" method="get">
        <label className="ui-field">
          <span className="ui-label">Action</span>
          <select className="ui-select" name="action" defaultValue={params.action ?? ""}>
            <option value="">Any</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </label>

        <label className="ui-field">
          <span className="ui-label">Since</span>
          <select className="ui-select" name="days" defaultValue={String(days)}>
            <option value="1">Last day</option>
            <option value="7">Last week</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>

        <button type="submit" className="ui-button" data-variant="secondary">
          <span>Search</span>
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="ui-hint">Nothing recorded in that window.</p>
      ) : (
        <>
          <p className="ui-hint">
            {/*
              An operator looking at exactly 200 rows cannot tell a complete
              list from a truncated one, and during an incident that is the
              difference between "it did not happen" and "I did not see it".
            */}
            {rows.length >= 200
              ? "Showing the most recent 200. There are more — narrow the window or the action."
              : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}.`}
          </p>
        <div
          className="ui-heatmap-scroll"
          // Focusable and named: it scrolls sideways, and without a tab stop
          // a keyboard user cannot reach the columns that are off-screen at
          // all. axe calls this scrollable-region-focusable, and it fires
          // only once the content actually overflows — which on a real class
          // it always will.
          tabIndex={0}
          role="region"
          aria-label="Audit entries, scrollable"
        >
          <table className="ui-audit">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Organisation</th>
                <th scope="col">Action</th>
                <th scope="col">Entity</th>
                <th scope="col">Role</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="tabular">
                    {new Intl.DateTimeFormat("en-IN", {
                      dateStyle: "short",
                      timeStyle: "short",
                      timeZone: "Asia/Kolkata",
                    }).format(row.createdAt)}
                  </td>
                  <td>{row.organizationName}</td>
                  <td>
                    <code>{row.action}</code>
                  </td>
                  <td>{row.entityType}</td>
                  <td>{row.actorRole ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      <p className="ui-hint">
        {/*
          Stated, because an operator will want the before/after and should
          know why it is not here rather than assume it was forgotten.
        */}
        The recorded before and after values are deliberately not shown. They can
        hold whatever changed, and answering &ldquo;was that class deleted&rdquo;
        does not need a student&rsquo;s phone number on screen to do it.
      </p>
    </Stack>
  );
}
