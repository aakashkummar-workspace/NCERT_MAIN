import "server-only";
import type { Prisma } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { enqueue } from "@/core/jobs/queue";
import { runQueue, type JobOutcome, type RunReport } from "@/core/jobs/runner";
import { MAX_ATTEMPTS, nextRunAt } from "./backoff";
import { deliverOnce } from "./deliver";
import { DELIVER_JOB, WEBHOOK_QUEUE, wireName } from "./events";
import { encodeFailure } from "./failure";
import { buildEventBody } from "./payload";

/**
 * Fan-out and delivery.
 *
 * ---------------------------------------------------------------------------
 * Fan-out is separate from emission, and that is what makes both simple
 * ---------------------------------------------------------------------------
 * The trigger that writes an outbox row knows nothing about endpoints: it runs
 * inside a teacher's publish and its only job is to record that something
 * happened, cheaply and without any possibility of failing the publish. Working
 * out who wants to hear about it is a read of three tables and a policy
 * decision, and it belongs on the runner's side of the commit.
 *
 * The consequence worth stating: an endpoint added on Tuesday receives nothing
 * that happened on Monday, because fan-out matched Monday's events against
 * Monday's subscriptions. That is the right way round — a new integration
 * quietly back-filling a week of marks into a school's report system is a
 * surprise nobody asked for — and it is why `published_at` is stamped rather
 * than the row deleted.
 */

/** How many events one pass will turn into jobs for a single tenant. */
const FANOUT_LIMIT = 200;

export async function runWebhookDeliveries(
  options: { now?: Date; batchSize?: number; fetchImpl?: typeof fetch } = {},
): Promise<RunReport> {
  return runQueue({
    queue: WEBHOOK_QUEUE,
    now: options.now,
    batchSize: options.batchSize,
    fanOut: fanOutOutbox,
    handle: (organizationId, job, now) =>
      deliverJob(organizationId, job, now, options.fetchImpl),
    onDead: alertDead,
  });
}

/** Turn everything unpublished into delivery jobs. Runs inside a tenant. */
export async function fanOutOutbox(
  tx: Prisma.TransactionClient,
  organizationId: string,
  now: Date,
): Promise<number> {
  const events = await tx.outboxEvent.findMany({
    where: { publishedAt: null },
    select: { id: true, topic: true },
    orderBy: { createdAt: "asc" },
    take: FANOUT_LIMIT,
  });
  if (events.length === 0) return 0;

  const endpoints = await tx.webhookEndpoint.findMany({
    where: { active: true },
    select: { id: true, events: true },
  });

  const jobs = events.flatMap((event) =>
    endpoints
      .filter((endpoint) => endpoint.events.includes(event.topic))
      .map((endpoint) => ({
        organizationId,
        queue: WEBHOOK_QUEUE,
        type: DELIVER_JOB,
        payload: {
          outboxId: event.id,
          endpointId: endpoint.id,
          // Carried on the job so the delivery log can name the event without
          // joining back to a row that fan-out may have long since published.
          event: wireName(event.topic),
        } satisfies Prisma.InputJsonValue,
        // Running fan-out twice — after a crash, or from two schedulers that
        // both fired — must queue nothing the second time.
        dedupeKey: `${event.id}:${endpoint.id}`,
        maxAttempts: MAX_ATTEMPTS,
        // The PASS's clock, not the wall clock.
        //
        // The claim that follows selects `run_after <= now`, and `now` was
        // taken when the pass began. Defaulting this to `new Date()` puts the
        // job a few milliseconds in the future, so it is never claimed by the
        // pass that created it — every event waits a whole cycle for no
        // reason, and a test that fans out and delivers in one call sees a
        // delivery that never happens. Found exactly that way.
        runAfter: now,
      })),
  );

  const queued = await enqueue(tx, jobs);

  // Stamped even when nothing matched. An event nobody subscribed to has been
  // considered, and leaving it unpublished would make the runner reconsider it
  // on every pass forever.
  await tx.outboxEvent.updateMany({
    where: { id: { in: events.map((event) => event.id) } },
    data: { publishedAt: now },
  });

  return queued;
}

async function deliverJob(
  organizationId: string,
  job: { id: string; type: string; payload: Prisma.JsonValue },
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<JobOutcome> {
  if (job.type !== DELIVER_JOB) {
    return {
      ok: false,
      retryable: false,
      failure: encodeFailure("unknown", { detail: `no handler for ${job.type}` }),
    };
  }

  const payload =
    job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
      ? (job.payload as Record<string, unknown>)
      : {};
  const outboxId = payload.outboxId;
  const endpointId = payload.endpointId;

  if (typeof outboxId !== "string" || typeof endpointId !== "string") {
    return {
      ok: false,
      retryable: false,
      failure: encodeFailure("gone", { detail: "job payload is malformed" }),
    };
  }

  const prepared = await withTenant(organizationId, async (tx) => {
    const endpoint = await tx.webhookEndpoint.findUnique({
      where: { id: endpointId },
      select: { id: true, url: true, secret: true, active: true, events: true },
    });
    if (!endpoint) return { kind: "gone" as const, detail: "endpoint deleted" };

    // ---------------------------------------------------------------------
    // Checked HERE, at send time, and not when the job was queued
    // ---------------------------------------------------------------------
    // Between fan-out and delivery a school may have switched the endpoint off
    // — very possibly because it was misdirected, or because the server it
    // points at has been decommissioned. Delivering anyway would mean the
    // "off" switch does not take effect for whatever is already in the queue,
    // which for a backlog is hours. Off means off from the moment it is
    // pressed, so a queued job is refused rather than sent.
    if (!endpoint.active) {
      return { kind: "inactive" as const, detail: "endpoint switched off" };
    }

    const event = await tx.outboxEvent.findUnique({
      where: { id: outboxId },
      select: {
        id: true,
        organizationId: true,
        topic: true,
        payload: true,
        createdAt: true,
      },
    });
    if (!event) return { kind: "gone" as const, detail: "event no longer exists" };

    // The same reasoning as the active check: unsubscribing is a decision about
    // what this endpoint receives from now on, and "from now on" includes the
    // backlog.
    if (!endpoint.events.includes(event.topic)) {
      return { kind: "inactive" as const, detail: "no longer subscribed" };
    }

    const body = await buildEventBody(tx, event);
    if (!body) return { kind: "gone" as const, detail: "nothing left to describe" };

    return {
      kind: "send" as const,
      url: endpoint.url,
      secret: endpoint.secret,
      body: JSON.stringify(body),
      event: body.type,
      eventId: body.id,
    };
  });

  if (prepared.kind !== "send") {
    // Terminal, and not an error to chase: the next attempt would find the same
    // refusal at the same cost.
    return {
      ok: false,
      retryable: false,
      failure: encodeFailure(prepared.kind, { detail: prepared.detail }),
    };
  }

  const outcome = await deliverOnce({
    url: prepared.url,
    secret: prepared.secret,
    body: prepared.body,
    event: prepared.event,
    eventId: prepared.eventId,
    deliveryId: job.id,
    now,
    fetchImpl,
  });

  if (outcome.ok) return { ok: true };

  return {
    ok: false,
    retryable: true,
    failure: outcome.failure,
    runAfter: nextRunAt(1, now),
  };
}

/**
 * The alert half of "goes DEAD and raises an alert rather than disappearing".
 *
 * Two places, because they answer different questions. The log line is for
 * whoever is watching the deployment; the audit row is what a platform admin
 * finds two months later when a school says its marks stopped arriving, and it
 * is searchable in `/admin/audit` beside everything else that happened that day.
 *
 * The console is the third and the one a school actually sees: `listEndpoints`
 * counts DEAD deliveries per endpoint, because an alert that only reaches us is
 * an integration the customer still cannot see failing.
 *
 * It never throws. A job that has already exhausted its attempts must not be
 * left unsettled because the record of its failure could not be written.
 */
async function alertDead(
  organizationId: string,
  job: { id: string; payload: Prisma.JsonValue },
  failure: string,
): Promise<void> {
  const payload =
    job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
      ? (job.payload as Record<string, unknown>)
      : {};

  console.error(
    `[webhooks] delivery ${job.id} is DEAD after every attempt — organization=${organizationId} endpoint=${String(payload.endpointId)} event=${String(payload.event)} failure=${failure}`,
  );

  try {
    await writeAudit({
      organizationId,
      action: "webhook.delivery_dead",
      entityType: "webhook_endpoint",
      entityId: typeof payload.endpointId === "string" ? payload.endpointId : undefined,
      // The machine code, not the receiver's prose. An audit row is read by a
      // platform admin during an incident and has no business holding a page of
      // somebody else's HTML.
      after: {
        jobId: job.id,
        event: payload.event ?? null,
        failure: failure.split(" ", 1)[0] ?? failure,
      },
    });
  } catch (error) {
    console.error(`[webhooks] could not record the dead-letter audit row:`, error);
  }
}
