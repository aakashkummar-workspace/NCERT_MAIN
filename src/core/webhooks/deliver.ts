import "server-only";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { internalHostReason, isPublicAddress } from "./address";
import { encodeFailure, isAccepted, type FailureKind } from "./failure";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signBody,
} from "./sign";

/**
 * One HTTP attempt at one endpoint.
 *
 * ---------------------------------------------------------------------------
 * It never throws
 * ---------------------------------------------------------------------------
 * The same rule as `sendSms()`, and here it protects the runner rather than a
 * person: one school's TLS certificate expiring must not take down the pass
 * that is also delivering everybody else's events. Every failure is a typed
 * result and the caller decides what to record.
 *
 * ---------------------------------------------------------------------------
 * Redirects are not followed
 * ---------------------------------------------------------------------------
 * `fetch` follows them by default, which would take a signed body carrying a
 * class's marks to whatever host the first one names — a host nobody at the
 * school configured and nobody here can see. A 3xx is reported as an
 * unacceptable status, which is what it is: the endpoint has moved and somebody
 * should say so in the box.
 */

/** How long a school's server gets to say "got it". */
const TIMEOUT_MS = 10_000;

export type DeliveryOutcome =
  | { ok: true; status: number }
  | { ok: false; retryable: boolean; failure: string };

export async function deliverOnce(input: {
  url: string;
  secret: string;
  body: string;
  event: string;
  eventId: string;
  deliveryId: string;
  now?: Date;
  /** Tests substitute this. Nothing else does. */
  fetchImpl?: typeof fetch;
}): Promise<DeliveryOutcome> {
  const now = input.now ?? new Date();
  const timestampSeconds = Math.floor(now.getTime() / 1000);
  const send = input.fetchImpl ?? (guardedSend as unknown as typeof fetch);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Sahayak-Webhooks/1",
    [EVENT_HEADER]: input.event,
    [EVENT_ID_HEADER]: input.eventId,
    // The job id, not the event id. A receiver seeing two deliveries with the
    // same event id and different delivery ids knows it is a retry and not a
    // second thing happening — which is the difference between importing marks
    // once and importing them twice.
    [DELIVERY_HEADER]: input.deliveryId,
    [TIMESTAMP_HEADER]: String(timestampSeconds),
    [SIGNATURE_HEADER]: signBody({
      secret: input.secret,
      timestampSeconds,
      body: input.body,
    }),
  };

  let response: Response;
  try {
    response = await send(input.url, {
      method: "POST",
      headers,
      body: input.body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const kind = classifyThrow(error);
    return {
      ok: false,
      // A network failure is the case retrying was invented for.
      retryable: true,
      failure: encodeFailure(kind, { detail: messageOf(error) }),
    };
  }

  if (isAccepted(response.status)) {
    return { ok: true, status: response.status };
  }

  // Read a little of the body for our own log, and cap it hard: a receiver
  // returning an HTML error page or a megabyte of stack trace must not be able
  // to fill this product's database with it.
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    detail = "";
  }

  return {
    ok: false,
    // 4xx other than 408 and 429 is the receiver saying the request itself is
    // wrong, and the next identical attempt will be just as wrong. It still
    // retries: the alternative is that a school whose server answers 400 during
    // a five-minute deploy loses events permanently, and the attempts are
    // spread over most of a day anyway. What it does NOT do is retry forever —
    // that is what max_attempts and DEAD are for.
    retryable: true,
    failure: encodeFailure("http", { status: response.status, detail }),
  };
}

// ---------------------------------------------------------------------------
// The real transport: https, with the resolved address checked on the socket
// ---------------------------------------------------------------------------

/** How much of a receiver's reply is kept. The log reads the first 500. */
const MAX_REPLY_BYTES = 4096;

export class BlockedAddressError extends Error {
  constructor(address: string) {
    super(`refused to connect: ${address} is not a public address`);
    this.name = "BlockedAddressError";
  }
}

/**
 * The lookup the connection itself uses.
 *
 * This is where server-side request forgery is actually stopped. The URL was
 * checked when it was saved, but a public name can resolve to 10.0.0.5 — or
 * resolve to a public address when saved and a private one later. Checking a
 * SEPARATE lookup before connecting would leave a window between the two
 * resolutions for a hostile DNS server to answer differently in; checking the
 * addresses handed to the socket leaves none. Every address must be public:
 * one private answer among several refuses the lot, rather than hoping the
 * socket picks the other one.
 */
export function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    const list = addresses as LookupAddress[];
    const blocked = list.find((entry) => !isPublicAddress(entry.address));
    if (list.length === 0 || blocked) {
      callback(new BlockedAddressError(blocked?.address ?? hostname), "");
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

/**
 * A POST over https that refuses internal addresses and never follows a
 * redirect, shaped like `fetch` so tests can keep substituting one.
 */
function guardedSend(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    // A literal IP never reaches a lookup, so it is checked here — which also
    // covers an endpoint saved before the save-time check existed.
    const hostProblem = internalHostReason(target.hostname);
    if (target.protocol !== "https:" || hostProblem) {
      reject(new BlockedAddressError(target.hostname));
      return;
    }

    const request = httpsRequest(
      target,
      {
        method: "POST",
        headers: init.headers as Record<string, string>,
        lookup: guardedLookup as unknown as LookupFunction,
        signal: init.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size < MAX_REPLY_BYTES) chunks.push(chunk);
          size += chunk.length;
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8").slice(0, MAX_REPLY_BYTES);
          const bodyless = [101, 204, 205, 304].includes(status);
          try {
            resolve(new Response(bodyless ? null : text, { status }));
          } catch (error) {
            reject(error);
          }
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(typeof init.body === "string" ? init.body : "");
  });
}

function classifyThrow(error: unknown): FailureKind {
  const name = error instanceof Error ? error.name : "";
  const message = messageOf(error).toLowerCase();
  // An internal address is a connection we refused to make. It is reported as
  // a connection failure, with the reason in the detail for whoever debugs it.
  if (error instanceof BlockedAddressError) return "connect";
  if (name === "TimeoutError" || message.includes("timeout")) return "timeout";
  if (name === "AbortError") return "timeout";
  if (
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("eai_again") ||
    message.includes("certificate") ||
    message.includes("fetch failed")
  ) {
    return "connect";
  }
  return "unknown";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // `fetch failed` on Node carries the real reason on `cause`, and without it
    // every network failure in the log reads identically.
    const cause = (error as { cause?: unknown }).cause;
    const causeMessage =
      cause instanceof Error ? `: ${cause.message}` : "";
    return `${error.message}${causeMessage}`;
  }
  return String(error);
}
