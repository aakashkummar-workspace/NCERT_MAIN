import { isIP } from "node:net";

/**
 * Where a webhook may NOT be sent.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * An endpoint URL is typed by a customer, and this server then makes a signed
 * POST to it on a schedule. Without a check that is a request forger aimed at
 * our own network: `https://169.254.169.254/` is the cloud metadata service,
 * `https://10.0.0.5/` is whatever else lives in the VPC, and the delivery log
 * would report back how each of them answered.
 *
 * ---------------------------------------------------------------------------
 * Checked twice, and the second one is the one that holds
 * ---------------------------------------------------------------------------
 * At save time the HOST is checked as written — a literal private address or
 * an obviously internal name is refused while somebody can still fix it. But a
 * public name can resolve to a private address, and can change what it
 * resolves to after it was saved (DNS rebinding). So the address the socket
 * actually connects to is checked again at send time, inside the lookup the
 * connection uses — see `deliver.ts`. A check on a separate lookup would leave
 * the gap between two resolutions open.
 *
 * Pure, and in its own file, so the whole table of refusals is unit-tested.
 */

/** The hostname as written is internal and must never be saved. */
export function internalHostReason(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "") return "That address has no host.";

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".intranet") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa")
  ) {
    return "That address points inside a private network. Deliveries go only to a public https address.";
  }

  if (isIP(host) !== 0) {
    return isPublicAddress(host)
      ? null
      : "That address is a private, loopback or reserved IP. Deliveries go only to a public https address.";
  }

  // A bare word with no dot is resolved against the server's own search
  // domains — which is to say, inside our network.
  if (!host.includes(".")) {
    return "Use the full public name of the server, including its domain.";
  }

  return null;
}

/**
 * True only for an address on the public internet.
 *
 * An allow-by-exclusion over the reserved ranges, for both families. Anything
 * that is not a parseable IP is not public — a connection to "something we
 * could not read" is refused, not attempted.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicV4(address);
  if (family === 6) return isPublicV6(address);
  return false;
}

function isPublicV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, 100.64/10
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicV6(address: string): boolean {
  const groups = expandV6(address);
  if (!groups) return false;

  // An IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible address is judged as
  // the IPv4 address it carries — otherwise ::ffff:127.0.0.1 walks straight
  // past every IPv4 rule above.
  const embedded = `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  const zeroPrefix = groups.slice(0, 5).every((g) => g === 0);
  if (zeroPrefix && groups[5] === 0xffff) return isPublicV4(embedded); // ::ffff:a.b.c.d
  // Everything else under ::/96 — the unspecified address, loopback, and the
  // deprecated IPv4-compatible form — is not somewhere a delivery goes.
  if (zeroPrefix && groups[5] === 0) return false;

  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return false; // unique local, fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local, fe80::/10
  if ((first & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  if (first === 0x0064 && groups[1] === 0xff9b) return false; // NAT64 — maps to IPv4
  if (first === 0x2002) return false; // 6to4 — embeds an IPv4 address
  return true;
}

/** Eight 16-bit groups, or null when it does not parse. */
function expandV6(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();

  // A trailing dotted IPv4 becomes two hex groups.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.some((n) => n > 255)) return null;
    const hex = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    text = text.slice(0, -dotted[1]!.length) + hex;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
}
