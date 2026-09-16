import { describe, expect, it } from "vitest";
import { internalHostReason, isPublicAddress } from "@/core/webhooks/address";
import { BlockedAddressError, deliverOnce, guardedLookup } from "@/core/webhooks/deliver";

/**
 * Where a webhook may not go.
 *
 * An endpoint URL is typed by a customer and then POSTed to by this server on
 * a schedule, so every row in this table is a way into our own network that
 * must stay shut: loopback, the private ranges, link-local (which is where the
 * cloud metadata service lives), CGNAT, and the IPv6 equivalents — including
 * the IPv4-mapped forms that would otherwise walk past every IPv4 rule.
 */

describe("the save-time host check", () => {
  it.each([
    "localhost",
    "api.localhost",
    "printer.local",
    "mis.internal",
    "127.0.0.1",
    "127.8.9.10",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "[::1]",
    "[::]",
    "[fc00::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:a9fe:a9fe]",
    "[::ffff:10.0.0.1]",
    "intranet",
  ])("refuses %s", (host) => {
    expect(internalHostReason(host)).not.toBeNull();
  });

  it.each([
    "mis.example.com",
    "hooks.school.edu.in",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "[2606:4700:4700::1111]",
    "[::ffff:8.8.8.8]",
  ])("allows %s", (host) => {
    expect(internalHostReason(host)).toBeNull();
  });
});

describe("the address the socket connects to", () => {
  it("treats anything unparseable as not public", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });

  it("refuses a name that RESOLVES to loopback, at connect time", async () => {
    // `localhost` stands in for a public-looking name whose DNS points inward
    // — the rebinding case the save-time check cannot see.
    const error = await new Promise<Error | null>((resolve) => {
      guardedLookup("localhost", {}, (err) => resolve(err));
    });
    expect(error).toBeInstanceOf(BlockedAddressError);
  });

  it("never sends to an internal address, and reports it as a failed connection", async () => {
    const outcome = await deliverOnce({
      url: "https://127.0.0.1:9/hook",
      secret: "whsec_test",
      body: "{}",
      event: "results.released",
      eventId: "evt_1",
      deliveryId: "job_1",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toMatch(/^connect/);
  });
});
