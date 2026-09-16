import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/core/identity/context";
import { listEndpoints } from "@/core/webhooks/endpoints";
import { ALL_EVENTS, describeEvent, wireName } from "@/core/webhooks/events";
import { Alert, Badge, EmptyState, PageHeader, type Tone } from "@/ui";
import { AddEndpoint } from "./AddEndpoint";
import { EndpointActions } from "./EndpointActions";

export const metadata: Metadata = { title: "Integrations" };

export const dynamic = "force-dynamic";

const when = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  succeeded: { label: "Delivered", tone: "success" },
  retrying: { label: "Retrying", tone: "warning" },
  dead: { label: "Gave up", tone: "danger" },
  refused: { label: "Not sent", tone: "neutral" },
};

/**
 * Integrations.
 *
 * ---------------------------------------------------------------------------
 * The delivery state is the page, not a detail on it
 * ---------------------------------------------------------------------------
 * An integration nobody can see failing is one that fails silently for a month,
 * and it is then discovered by a parent asking why the report card is empty. So
 * the first thing on every row is what happened last time and what happens
 * next, and an endpoint that has given up says so in red with a number beside
 * it — never "some deliveries failed", because a count is what tells an office
 * whether this is a blip or a fortnight.
 *
 * The role gate is the layout's: this page is inside `/institute`, which redirects a
 * teacher and 404s an organization whose plan does not include the console. It
 * does not repeat either check, because a surface is gated by its layout and
 * page twenty is written by somebody who has not read this file.
 */
export default async function WebhooksPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  const endpoints = await listEndpoints(session.actor.organizationId);
  const anyDead = endpoints.some((endpoint) => endpoint.health.dead > 0);

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Send what happens here to the software your office already runs. We post a signed message; your system answers 2xx."
      />

      {anyDead && (
        <Alert tone="danger" title="Some events were never delivered">
          One or more endpoints below stopped accepting deliveries and we have
          stopped retrying those events. Nothing is lost — each one is still
          listed in its log — but they will not be sent again on their own.
        </Alert>
      )}

      <section className="ui-wh-explainer">
        <h2 className="ui-section-heading">What your system will receive</h2>
        <ul className="ui-wh-catalogue">
          {ALL_EVENTS.map((event) => {
            const detail = describeEvent(event);
            return (
              <li key={event}>
                <code className="ui-wh-code">{wireName(event)}</code>
                <span className="ui-wh-catalogue-title">{detail.title}</span>
                <span className="ui-wh-catalogue-blurb">{detail.blurb}</span>
              </li>
            );
          })}
        </ul>
        <p className="ui-wh-note">
          Deliveries carry ids, marks and dates. They never carry a student&rsquo;s
          name, phone number, or anything a student wrote — your system already
          knows its own children, and a second copy of their contact details
          travelling between two servers is not something either of us needs.
        </p>
      </section>

      <AddEndpoint />

      {endpoints.length === 0 ? (
        <EmptyState
          icon="⇄"
          title="No integrations yet"
          body="Add the address your MIS listens on and choose what it should hear about. Nothing is sent until you do."
        />
      ) : (
        <section className="ui-wh-list">
          <h2 className="ui-section-heading">Endpoints</h2>
          {endpoints.map((endpoint) => {
            const outcome = endpoint.health.lastOutcome
              ? OUTCOME[endpoint.health.lastOutcome]
              : null;
            return (
              <article key={endpoint.id} className="ui-wh-card">
                <div className="ui-wh-card-head">
                  <div className="ui-wh-card-id">
                    <h3 className="ui-wh-label">{endpoint.label}</h3>
                    <p className="ui-wh-url">{endpoint.url}</p>
                  </div>
                  <div className="ui-wh-card-badges">
                    {endpoint.active ? (
                      <Badge tone="primary">On</Badge>
                    ) : (
                      <Badge tone="neutral">
                        Off
                        {endpoint.deactivatedAt
                          ? ` since ${when.format(endpoint.deactivatedAt)}`
                          : ""}
                      </Badge>
                    )}
                    {outcome && <Badge tone={outcome.tone}>{outcome.label}</Badge>}
                  </div>
                </div>

                <ul className="ui-wh-events">
                  {endpoint.events.map((event) => (
                    <li key={event}>
                      <code className="ui-wh-code">{wireName(event)}</code>
                    </li>
                  ))}
                </ul>

                <dl className="ui-wh-health">
                  <div>
                    <dt>Last attempt</dt>
                    <dd>
                      {endpoint.health.lastAttemptAt
                        ? when.format(endpoint.health.lastAttemptAt)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Next retry</dt>
                    <dd>
                      {endpoint.health.nextRetryAt
                        ? when.format(endpoint.health.nextRetryAt)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Waiting</dt>
                    <dd>{endpoint.health.pending}</dd>
                  </div>
                  <div>
                    <dt>Gave up</dt>
                    <dd data-alarm={endpoint.health.dead > 0 ? "yes" : undefined}>
                      {endpoint.health.dead}
                    </dd>
                  </div>
                </dl>

                {endpoint.health.lastProblem && (
                  <p className="ui-wh-problem">{endpoint.health.lastProblem}</p>
                )}

                <div className="ui-wh-card-actions">
                  <Link
                    href={`/institute/webhooks/${endpoint.id}`}
                    className="ui-button"
                    data-variant="secondary"
                    data-size="sm"
                  >
                    <span>Delivery log</span>
                  </Link>
                  <EndpointActions id={endpoint.id} active={endpoint.active} />
                </div>
              </article>
            );
          })}
        </section>
      )}
    </>
  );
}
