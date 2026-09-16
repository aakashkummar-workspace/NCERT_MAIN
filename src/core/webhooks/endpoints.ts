import "server-only";
import type { WebhookEvent } from "@prisma/client";
import { withTenant } from "@/db/tenant";
import { writeAudit } from "@/core/identity/audit";
import { DELIVER_JOB, isWebhookEvent } from "./events";
import { newSecret } from "./sign";
import { describeFailure, parseFailure } from "./failure";
import { internalHostReason } from "./address";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * A school's webhook endpoints, and what has happened to them.
 *
 * ---------------------------------------------------------------------------
 * The secret leaves this module exactly twice
 * ---------------------------------------------------------------------------
 * `create` and `rotate` return it, because that is the only moment anybody can
 * be handed it. Every other function here selects explicit columns and `secret`
 * is not among them, so a new read path cannot pick it up by accident — the
 * same allow-list habit the AI scrubber follows, for the same reason.
 *
 * There is deliberately no `revealSecret`. It would exist to save somebody the
 * two minutes that rotating takes, and it would be a permanent way to lift
 * every integration key in an organization with one borrowed session.
 */

export type EndpointSummary = {
  id: string;
  url: string;
  label: string;
  events: WebhookEvent[];
  active: boolean;
  deactivatedAt: Date | null;
  createdAt: Date;
  /** Delivery health, so the list can say which one is broken. */
  health: EndpointHealth;
};

export type EndpointHealth = {
  pending: number;
  /** Exhausted every attempt. The number that has to be visible. */
  dead: number;
  succeededRecently: number;
  lastAttemptAt: Date | null;
  lastOutcome: "succeeded" | "retrying" | "dead" | "refused" | null;
  /** Already a sentence for a person; never a receiver's own words. */
  lastProblem: string | null;
  nextRetryAt: Date | null;
};

export type DeliveryRow = {
  jobId: string;
  event: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  /** The classified sentence, or null when nothing has gone wrong. */
  problem: string | null;
  /** Just the machine code — `http:502` — for somebody scanning the column. */
  problemCode: string | null;
};

const MAX_ENDPOINTS = 10;

export type CreateResult =
  | { ok: true; id: string; secret: string }
  | { ok: false; message: string };

export async function createEndpoint(
  actor: { organizationId: string; userId: string; role: string },
  input: { url: string; label: string; events: string[] },
): Promise<CreateResult> {
  const url = input.url.trim();
  const label = input.label.trim();

  const urlProblem = checkUrl(url);
  if (urlProblem) return { ok: false, message: urlProblem };

  if (label.length < 2) {
    return {
      ok: false,
      message: "Give this a name the office will recognise later.",
    };
  }

  const events = input.events.filter(isWebhookEvent);
  if (events.length !== input.events.length) {
    return { ok: false, message: "One of those events is not one we send." };
  }
  if (events.length === 0) {
    return {
      ok: false,
      message:
        "Choose at least one event. An endpoint subscribed to nothing would never be sent anything.",
    };
  }

  const secret = newSecret();

  const created = await withTenant(actor.organizationId, async (tx) => {
    const existing = await tx.webhookEndpoint.count();
    if (existing >= MAX_ENDPOINTS) return null;

    return tx.webhookEndpoint.create({
      data: {
        organizationId: actor.organizationId,
        url,
        label,
        secret,
        events,
        createdById: actor.userId,
      },
      select: { id: true },
    });
  });

  if (!created) {
    return {
      ok: false,
      message: `An organisation may have ${MAX_ENDPOINTS} endpoints. Switch one off before adding another.`,
    };
  }

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "webhook.endpoint_created",
    entityType: "webhook_endpoint",
    entityId: created.id,
    // The URL and the subscription, never the secret. An audit row is read by a
    // platform admin during an incident, and a signing key in it would be a
    // signing key in a table nobody can delete from.
    after: { url, label, events },
  });

  return { ok: true, id: created.id, secret };
}

export async function rotateSecret(
  actor: { organizationId: string; userId: string; role: string },
  id: string,
): Promise<{ ok: true; secret: string } | { ok: false; message: string }> {
  if (!isUuid(id)) return { ok: false, message: "We could not find that endpoint." };
  const secret = newSecret();

  const updated = await withTenant(actor.organizationId, (tx) =>
    tx.webhookEndpoint.updateMany({ where: { id }, data: { secret } }),
  );
  if (updated.count === 0) {
    return { ok: false, message: "We could not find that endpoint." };
  }

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "webhook.secret_rotated",
    entityType: "webhook_endpoint",
    entityId: id,
  });

  return { ok: true, secret };
}

export async function updateEndpoint(
  actor: { organizationId: string; userId: string; role: string },
  id: string,
  input: { active?: boolean; events?: string[]; url?: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isUuid(id)) return { ok: false, message: "We could not find that endpoint." };
  const data: {
    active?: boolean;
    deactivatedAt?: Date | null;
    events?: WebhookEvent[];
    url?: string;
  } = {};

  if (input.url !== undefined) {
    const url = input.url.trim();
    const problem = checkUrl(url);
    if (problem) return { ok: false, message: problem };
    data.url = url;
  }

  if (input.events !== undefined) {
    const events = input.events.filter(isWebhookEvent);
    if (events.length !== input.events.length) {
      return { ok: false, message: "One of those events is not one we send." };
    }
    if (events.length === 0) {
      return {
        ok: false,
        message:
          "Choose at least one event, or switch the endpoint off — those are different things and only one of them is reversible without reconfiguring the other end.",
      };
    }
    data.events = events;
  }

  if (input.active !== undefined) {
    data.active = input.active;
    // Stamped on the way down and cleared on the way back up, so the console
    // can say "off since Tuesday" rather than only "off".
    data.deactivatedAt = input.active ? null : new Date();
  }

  if (Object.keys(data).length === 0) return { ok: true };

  const updated = await withTenant(actor.organizationId, (tx) =>
    tx.webhookEndpoint.updateMany({ where: { id }, data }),
  );
  if (updated.count === 0) {
    return { ok: false, message: "We could not find that endpoint." };
  }

  await writeAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: input.active === false ? "webhook.endpoint_disabled" : "webhook.endpoint_updated",
    entityType: "webhook_endpoint",
    entityId: id,
    after: { ...input },
  });

  return { ok: true };
}

/** The list, with the health of each. No secrets in the projection. */
export async function listEndpoints(
  organizationId: string,
  now = new Date(),
): Promise<EndpointSummary[]> {
  return withTenant(organizationId, async (tx) => {
    const endpoints = await tx.webhookEndpoint.findMany({
      select: {
        id: true,
        url: true,
        label: true,
        events: true,
        active: true,
        deactivatedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const health = await Promise.all(
      endpoints.map(async (endpoint) => {
        const jobs = await tx.job.findMany({
          where: {
            type: DELIVER_JOB,
            payload: { path: ["endpointId"], equals: endpoint.id },
          },
          select: {
            status: true,
            attempts: true,
            runAfter: true,
            finishedAt: true,
            createdAt: true,
            lastError: true,
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        });
        return summarise(jobs, now);
      }),
    );

    return endpoints.map((endpoint, index) => ({
      ...endpoint,
      health: health[index]!,
    }));
  });
}

/**
 * The log for one endpoint.
 *
 * An integration nobody can see failing is one that fails silently for a month,
 * and then it is discovered by a parent asking why the report card is empty. So
 * every attempt is listed, including the refusals and the ones that never went
 * out — the same reasoning the SMS ledger records `SKIPPED` rather than nothing.
 */
export async function deliveryLog(
  organizationId: string,
  endpointId: string,
  limit = 40,
): Promise<{ endpoint: EndpointSummary; deliveries: DeliveryRow[] } | null> {
  // A malformed id names no endpoint — a 404, never a 500 from Postgres.
  if (!isUuid(endpointId)) return null;
  const result = await withTenant(organizationId, async (tx) => {
    const endpoint = await tx.webhookEndpoint.findUnique({
      where: { id: endpointId },
      select: {
        id: true,
        url: true,
        label: true,
        events: true,
        active: true,
        deactivatedAt: true,
        createdAt: true,
      },
    });
    if (!endpoint) return null;

    const jobs = await tx.job.findMany({
      where: {
        type: DELIVER_JOB,
        payload: { path: ["endpointId"], equals: endpointId },
      },
      select: {
        id: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        runAfter: true,
        createdAt: true,
        finishedAt: true,
        lastError: true,
        payload: true,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return { endpoint, jobs };
  });

  if (!result) return null;

  const now = new Date();
  const deliveries: DeliveryRow[] = result.jobs.map((job) => {
    const payload =
      job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
        ? (job.payload as Record<string, unknown>)
        : {};
    const parsed = parseFailure(job.lastError);
    return {
      jobId: job.id,
      event: typeof payload.event === "string" ? payload.event : "unknown",
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      lastAttemptAt: job.attempts > 0 ? (job.finishedAt ?? job.runAfter) : null,
      nextRetryAt: job.status === "PENDING" && job.attempts > 0 ? job.runAfter : null,
      problem: describeFailure(job.lastError),
      problemCode: parsed
        ? `${parsed.kind}${parsed.status === null ? "" : `:${parsed.status}`}`
        : null,
    };
  });

  return {
    endpoint: {
      ...result.endpoint,
      health: summarise(
        result.jobs.map((job) => ({
          status: job.status,
          attempts: job.attempts,
          runAfter: job.runAfter,
          finishedAt: job.finishedAt,
          createdAt: job.createdAt,
          lastError: job.lastError,
        })),
        now,
      ),
    },
    deliveries,
  };
}

type JobFacts = {
  status: string;
  attempts: number;
  runAfter: Date;
  finishedAt: Date | null;
  createdAt: Date;
  lastError: string | null;
};

function summarise(jobs: JobFacts[], now: Date): EndpointHealth {
  const dead = jobs.filter((job) => job.status === "DEAD").length;
  const pending = jobs.filter(
    (job) => job.status === "PENDING" || job.status === "RUNNING",
  ).length;
  const succeededRecently = jobs.filter((job) => job.status === "SUCCEEDED").length;

  const attempted = jobs.filter((job) => job.attempts > 0);
  const last = attempted[0] ?? null;

  const nextRetry = jobs
    .filter((job) => job.status === "PENDING" && job.runAfter > now)
    .map((job) => job.runAfter)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    pending,
    dead,
    succeededRecently,
    lastAttemptAt: last ? (last.finishedAt ?? last.runAfter) : null,
    lastOutcome: last ? outcomeOf(last) : null,
    lastProblem: last ? describeFailure(last.lastError) : null,
    nextRetryAt: nextRetry ?? null,
  };
}

function outcomeOf(job: JobFacts): EndpointHealth["lastOutcome"] {
  if (job.status === "SUCCEEDED") return "succeeded";
  if (job.status === "DEAD") return "dead";
  if (job.status === "FAILED") return "refused";
  return "retrying";
}

/**
 * https only, and no credentials in the URL.
 *
 * The payload is signed, not encrypted: over http anybody on the path reads a
 * class's marks. And `https://user:pass@host` puts a credential somewhere it
 * will be logged by every proxy between here and there — the signature is the
 * authentication, so there is nothing this could be for.
 */
function checkUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That does not look like a web address.";
  }
  if (parsed.protocol !== "https:") {
    return "The address must start with https. These deliveries carry a class's marks, and http sends them in the clear.";
  }
  if (parsed.username || parsed.password) {
    return "Take the username and password out of the address. Deliveries are signed, so the receiving system does not need them — and every proxy in between would log them.";
  }
  // Not a loopback, private, link-local or otherwise internal host. The name
  // is checked here as written; what it RESOLVES to is checked again on every
  // send, where DNS cannot be changed underneath the check.
  return internalHostReason(parsed.hostname);
}
