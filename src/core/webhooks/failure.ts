/**
 * What went wrong, said twice.
 *
 * ---------------------------------------------------------------------------
 * A receiver's error text never reaches a person
 * ---------------------------------------------------------------------------
 * The same rule the AI gateway and the SMS gateway already follow, and it is
 * not squeamishness. A body returned by somebody else's server is arbitrary
 * text of arbitrary length that we did not write and cannot vouch for: it may
 * be a stack trace naming their internal hosts, an HTML error page, a
 * megabyte of it, or — on a misconfigured MIS — a row of somebody's data. None
 * of that belongs on a school administrator's screen, and "Cannot read property
 * 'studentId' of undefined" tells them nothing they can act on either.
 *
 * So a failure is stored in a form THIS product wrote — a short machine code, a
 * bounded fragment kept for us — and rendered from the code alone. `encode` and
 * `describe` are the two halves and they live in one file so that adding a
 * failure kind without a sentence for it is visible.
 *
 * The bounded fragment is still kept, because "it failed" is not a support
 * answer either. It is read by whoever is debugging the integration, from the
 * database or a log, and never sent to a browser: `deliveryLog()` projects the
 * code and drops the rest.
 */

export type FailureKind =
  /** The receiver answered, with a status we cannot treat as success. */
  | "http"
  /** No answer within the timeout. */
  | "timeout"
  /** DNS, TLS, refused — we never got as far as a status. */
  | "connect"
  /** The endpoint was switched off between queueing and sending. */
  | "inactive"
  /** The event describes something that is no longer there to describe. */
  | "gone"
  /** Anything else, which should be rare and is worth noticing if it is not. */
  | "unknown";

/** How much of a receiver's reply we keep. Enough to recognise, not to host. */
const DETAIL_LIMIT = 300;

/**
 * `kind:code detail`. Parsed only by `describe`; never shown as-is.
 */
export function encodeFailure(
  kind: FailureKind,
  options: { status?: number; detail?: string } = {},
): string {
  const code = options.status === undefined ? "" : String(options.status);
  const detail = (options.detail ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DETAIL_LIMIT);
  return `${kind}:${code} ${detail}`.trimEnd();
}

export type ParsedFailure = { kind: FailureKind; status: number | null };

export function parseFailure(stored: string | null): ParsedFailure | null {
  if (!stored) return null;
  const head = stored.split(" ", 1)[0] ?? "";
  const [kind, code] = head.split(":");
  if (!kind) return null;
  const known: readonly string[] = [
    "http",
    "timeout",
    "connect",
    "inactive",
    "gone",
    "unknown",
  ];
  return {
    kind: (known.includes(kind) ? kind : "unknown") as FailureKind,
    status: code && /^\d+$/.test(code) ? Number(code) : null,
  };
}

/**
 * One sentence, for the person who has to fix it.
 *
 * Every one of them names something the reader can do. "Delivery failed" is
 * true and is the sentence that teaches an administrator to stop reading this
 * page.
 */
export function describeFailure(stored: string | null): string | null {
  const parsed = parseFailure(stored);
  if (!parsed) return null;

  switch (parsed.kind) {
    case "http": {
      const status = parsed.status;
      if (status === 401 || status === 403) {
        return "The receiving system rejected the request as unauthorised. Check that it is using the current signing secret — rotating one and not updating the other end looks exactly like this.";
      }
      if (status === 404) {
        return "The receiving system says that address does not exist. Check the URL below.";
      }
      if (status === 410) {
        return "The receiving system says that address has been withdrawn. It will need a new one, or this endpoint switched off.";
      }
      if (status === 429) {
        return "The receiving system asked us to slow down. Deliveries are spaced out and will keep trying.";
      }
      if (status !== null && status >= 500) {
        return `The receiving system answered with an error (${status}). That is usually theirs to fix; deliveries will keep retrying meanwhile.`;
      }
      return status === null
        ? "The receiving system answered in a way we could not accept."
        : `The receiving system answered ${status}, which we cannot treat as accepted. It needs to answer 2xx.`;
    }
    case "timeout":
      return "The receiving system did not answer in time. If it does slow work when an event arrives, it should accept first and do the work afterwards.";
    case "connect":
      return "We could not reach the receiving system at all — the address may be wrong, or it may not be reachable from the internet.";
    case "inactive":
      return "This endpoint was switched off before the event could be sent, so it was not sent.";
    case "gone":
      return "What this event described no longer exists, so there was nothing to send.";
    case "unknown":
      return "Delivery did not complete. The details are in the server log for this delivery.";
  }
}

/** A 2xx is accepted and nothing else is. Redirects included — see deliver.ts. */
export function isAccepted(status: number): boolean {
  return status >= 200 && status < 300;
}
