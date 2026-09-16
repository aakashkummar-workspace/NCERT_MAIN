import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { deliveryLog } from "@/core/webhooks/endpoints";
import { wireName } from "@/core/webhooks/events";
import { Badge, EmptyState, PageHeader, type Tone } from "@/ui";

export const metadata: Metadata = { title: "Delivery log" };

export const dynamic = "force-dynamic";

const when = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

const STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Waiting", tone: "warning" },
  RUNNING: { label: "Sending", tone: "primary" },
  SUCCEEDED: { label: "Delivered", tone: "success" },
  FAILED: { label: "Not sent", tone: "neutral" },
  DEAD: { label: "Gave up", tone: "danger" },
};

/**
 * Every attempt at one endpoint, newest first.
 *
 * Including the ones that were never sent. `FAILED` here means we refused —
 * the endpoint was switched off after the event was queued, or what the event
 * described no longer exists — and it is listed rather than hidden for the same
 * reason the SMS ledger records `SKIPPED`: silence looks identical to a bug,
 * and "nothing was sent" is the fact a support call needs.
 *
 * The problem column is a sentence this product wrote. The receiving system's
 * own error text is kept for us and never rendered: it is arbitrary text of
 * arbitrary length from a server we do not control, and "Cannot read property
 * 'studentId' of undefined" tells an office nothing it can act on.
 */
export default async function DeliveryLogPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const { id } = await params;
  const log = await deliveryLog(session.actor.organizationId, id);
  if (!log) notFound();

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/institute/webhooks">Integrations</Link>}
        title={log.endpoint.label}
        description={log.endpoint.url}
        actions={
          log.endpoint.active ? (
            <Badge tone="primary">On</Badge>
          ) : (
            <Badge tone="neutral">Off</Badge>
          )
        }
      />

      <p className="ui-wh-note">
        Subscribed to{" "}
        {log.endpoint.events.map((event, index) => (
          <span key={event}>
            {index > 0 ? ", " : ""}
            <code className="ui-wh-code">{wireName(event)}</code>
          </span>
        ))}
        . Each delivery is tried up to five times, spaced further apart each
        time; after that it is listed here as &ldquo;Gave up&rdquo; and is not
        sent again.
      </p>

      {log.deliveries.length === 0 ? (
        <EmptyState
          icon="⇄"
          title="Nothing has been sent yet"
          body="Deliveries appear here as soon as one of the subscribed events happens — a paper published, results released, or a student joining a class."
        />
      ) : (
        <div className="ui-wh-log-scroll" tabIndex={0} role="region" aria-label="Delivery log">
          <table className="ui-wh-log">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Queued</th>
                <th scope="col">Last attempt</th>
                <th scope="col">Tries</th>
                <th scope="col">Next retry</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {log.deliveries.map((delivery) => {
                const status = STATUS[delivery.status] ?? {
                  label: delivery.status,
                  tone: "neutral" as Tone,
                };
                return (
                  <tr key={delivery.jobId}>
                    <td>
                      <code className="ui-wh-code">{delivery.event}</code>
                    </td>
                    <td>{when.format(delivery.createdAt)}</td>
                    <td>
                      {delivery.lastAttemptAt
                        ? when.format(delivery.lastAttemptAt)
                        : "—"}
                    </td>
                    <td>
                      {delivery.attempts} of {delivery.maxAttempts}
                    </td>
                    <td>
                      {delivery.nextRetryAt ? when.format(delivery.nextRetryAt) : "—"}
                    </td>
                    <td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {delivery.problem && (
                        <span className="ui-wh-log-problem">
                          {delivery.problem}
                          {delivery.problemCode && (
                            <span className="ui-wh-log-code">
                              {delivery.problemCode}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
