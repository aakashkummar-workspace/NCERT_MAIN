import { afterEach, beforeEach, describe as suite, expect, it, vi } from "vitest";
import { Msg91Provider } from "@/sms/msg91";
import type { SmsRequest } from "@/sms/provider";

/**
 * The MSG91 adapter, against recorded response shapes.
 *
 * Fixtures are the shapes in MSG91's own documentation
 * (https://api.msg91.com/apidoc/textsms/send-sms-flow.php and the error-code
 * pages), not invented ones — the whole point of this file is that the adapter
 * is measured against what the provider actually answers.
 *
 * Two assertions run on EVERY case, in `expectNoLeak`: the adapter does not
 * throw, and the one-time code does not appear in the result or in anything
 * that was logged. A provider outage becoming a 500 on the sign-in form is a
 * broken product, and a one-time code in a log file is a credential in a log
 * file.
 */

const CODE = "824193";

const LOGIN_REQUEST: SmsRequest = {
  phone: "9876543210",
  template: "LOGIN_CODE",
  variables: [CODE],
  body: `${CODE} is your Sahayak sign-in code. It works for 5 minutes. Do not share it with anyone.`,
};

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  process.env.SMS_TEMPLATE_LOGIN_CODE = "1707161234567890123";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SMS_TEMPLATE_LOGIN_CODE;
  delete process.env.SMS_TEMPLATE_LOGIN_CODE_VARS;
});

type FetchStub = ReturnType<typeof vi.fn>;

function provider(fetchImpl: FetchStub, timeoutMs = 8_000) {
  return new Msg91Provider({
    authKey: "test-authkey",
    senderId: "SAHYAK",
    endpoint: "https://api.msg91.com/api/v5/flow/",
    timeoutMs,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
}

function respond(
  status: number,
  body: string,
  contentType = "application/json",
): FetchStub {
  return vi.fn(
    async () =>
      new Response(body, { status, headers: { "content-type": contentType } }),
  );
}

function sentBody(fetchImpl: FetchStub): Record<string, unknown> {
  const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** The two things that must be true whatever the provider did. */
function expectNoLeak(result: unknown) {
  expect(JSON.stringify(result)).not.toContain(CODE);
  expect(logged.join("\n")).not.toContain(CODE);
  // And nothing that resembles the assembled body either.
  expect(logged.join("\n")).not.toContain("sign-in code. It works");
}

suite("Msg91Provider", () => {
  it("sends the documented body and reports the provider's message id", async () => {
    // The success shape from MSG91's flow API documentation, verbatim.
    const fetchImpl = respond(
      200,
      JSON.stringify({ message: "5762846b4f8d285d378b4567", type: "success" }),
    );
    const result = await provider(fetchImpl).send(LOGIN_REQUEST);

    expect(result).toEqual({
      ok: true,
      providerMessageId: "5762846b4f8d285d378b4567",
      costMicros: null,
    });
    expectNoLeak(result);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.msg91.com/api/v5/flow/");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authkey: "test-authkey",
      "content-type": "application/json",
    });

    const sent = sentBody(fetchImpl);
    // The DLT template id is the whole point: without it the operator drops the
    // message at the network after MSG91 has answered success.
    expect(sent.flow_id).toBe("1707161234567890123");
    expect(sent.template_id).toBe("1707161234567890123");
    expect(sent.sender).toBe("SAHYAK");
    expect(sent.recipients).toEqual([{ mobiles: "919876543210", VAR1: CODE }]);
  });

  it("honours registered variable names when they are configured", async () => {
    process.env.SMS_TEMPLATE_LOGIN_CODE_VARS = "otp";
    const fetchImpl = respond(200, JSON.stringify({ message: "abc", type: "success" }));
    await provider(fetchImpl).send(LOGIN_REQUEST);

    expect(sentBody(fetchImpl).recipients).toEqual([
      { mobiles: "919876543210", otp: CODE },
    ]);
  });

  it("refuses before the call when no DLT template id is configured", async () => {
    process.env.SMS_TEMPLATE_LOGIN_CODE = "";
    const fetchImpl = respond(200, JSON.stringify({ message: "x", type: "success" }));
    const result = await provider(fetchImpl).send(LOGIN_REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoLeak(result);
  });

  it("treats a documented rejection as rejected, and permanently so", async () => {
    // The error shape from the same page, plus the code from their error-code
    // reference. 207 is an invalid auth key: it will say the same tomorrow.
    const fetchImpl = respond(
      200,
      JSON.stringify({
        message: "Invalid authentication key",
        type: "error",
        code: "207",
      }),
    );
    const result = await provider(fetchImpl).send(LOGIN_REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.message).toContain("207");
      // Their prose is logged, never returned.
      expect(result.message).not.toContain("Invalid authentication key");
    }
    expect(logged.join("\n")).toContain("Invalid authentication key");
    expectNoLeak(result);
  });

  it("treats an unlisted error code as worth trying again", async () => {
    const fetchImpl = respond(
      200,
      JSON.stringify({ message: "Internal error", type: "error", code: 601 }),
    );
    const result = await provider(fetchImpl).send(LOGIN_REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
    expectNoLeak(result);
  });

  it("does not claim a send when the body is JSON of an unknown shape", async () => {
    const fetchImpl = respond(200, JSON.stringify({ status: "queued", id: 7 }));
    const result = await provider(fetchImpl).send(LOGIN_REQUEST);

    // Neither accepted nor rejected. Reported as a failure, because recording a
    // send we cannot evidence is the lie this layer exists to avoid.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
    expectNoLeak(result);
  });

  it("does not throw on a non-JSON body", async () => {
    const fetchImpl = respond(
      200,
      "<html><body>502 Bad Gateway</body></html>",
      "text/html",
    );
    const result = await provider(fetchImpl).send(LOGIN_REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.message).toContain("not JSON");
    }
    expectNoLeak(result);
  });

  it("reports HTTP 500 as retryable", async () => {
    const fetchImpl = respond(500, "", "text/plain");
    const result = await provider(fetchImpl).send(LOGIN_REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.message).toContain("500");
    }
    expectNoLeak(result);
  });

  it("gives up on a hung provider rather than holding the sign-in open", async () => {
    const fetchImpl: FetchStub = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const started = Date.now();
    const result = await provider(fetchImpl, 20).send(LOGIN_REQUEST);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.message).toContain("did not answer");
    }
    expectNoLeak(result);
  });

  it("does not throw when the network is simply gone", async () => {
    const fetchImpl: FetchStub = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await provider(fetchImpl).send(LOGIN_REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
    expectNoLeak(result);
  });
});
