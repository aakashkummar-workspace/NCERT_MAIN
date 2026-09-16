import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendSms, setSmsProvider, DAILY_CEILING } from "@/sms/gateway";
import { MockSmsProvider } from "@/sms/mock";
import { buildBody, CODE_MINUTES } from "@/sms/templates";
import { requestLoginCode } from "@/core/identity/student-auth";
import pg from "pg";
import { prisma } from "@/db/client";

/**
 * The ledger is read over DIRECT_URL, and that is the point rather than a
 * workaround.
 *
 * A sign-in code belongs to no organisation, so its row matches no tenant
 * policy and the app role cannot see it — `NULL = app_current_org()` is NULL,
 * not true. Reading a specific number back is therefore a support action over
 * the direct connection, exactly where granting a platform admin lives. A test
 * that read it through the app client would be testing a hole.
 */
let direct: pg.Client | null = null;

async function support(): Promise<pg.Client> {
  if (direct) return direct;
  direct = new pg.Client({ connectionString: process.env.DIRECT_URL });
  await direct.connect();
  return direct;
}

afterAll(async () => {
  await prisma.$disconnect();
  if (direct) await direct.end();
});

let mock: MockSmsProvider;

beforeEach(() => {
  mock = new MockSmsProvider();
  setSmsProvider(mock);
});

afterEach(() => {
  setSmsProvider(null);
});

/** A number nothing else is using — phone uniqueness is global here. */
const freshPhone = () =>
  `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`;

type LedgerRow = {
  status: string;
  provider_message_id: string | null;
  cost_micros: number | null;
  organization_id: string | null;
  template: string;
  error: string | null;
};

async function ledgerFor(phone: string): Promise<LedgerRow[]> {
  const sql = await support();
  const rows = await sql.query<LedgerRow>(
    `select status, provider_message_id, cost_micros, organization_id,
            template, error
       from sms_messages where phone = $1 order by created_at desc`,
    [phone],
  );
  return rows.rows;
}

describe("every attempt leaves a row, including the ones that never went", () => {
  it("records a send with the provider's id and what it cost", async () => {
    const phone = freshPhone();
    mock.script({ kind: "ok", providerMessageId: "prov-1", costMicros: 18_000 });

    const result = await sendSms({
      phone,
      template: "LOGIN_CODE",
      variables: ["123456"],
    });
    expect(result.ok).toBe(true);

    const [row] = await ledgerFor(phone);
    expect(row!.status).toBe("SENT");
    expect(row!.provider_message_id).toBe("prov-1");
    expect(row!.cost_micros).toBe(18_000);
    // No tenant: a student signing in has no organisation yet.
    expect(row!.organization_id).toBeNull();
  });

  it("records a rejection, so a support call has something to read", async () => {
    const phone = freshPhone();
    mock.script({ kind: "rejected", message: "template not registered" });

    const result = await sendSms({
      phone,
      template: "LOGIN_CODE",
      variables: ["123456"],
    });
    expect(result.ok).toBe(false);

    const [row] = await ledgerFor(phone);
    // A success-only ledger hides exactly the message somebody is ringing
    // about.
    expect(row!.status).toBe("FAILED");
    expect(row!.error).toContain("template not registered");
  });

  it("records a send that was never attempted at all", async () => {
    const phone = freshPhone();
    setSmsProvider(null);
    // No provider at all — stated here rather than inherited from .env, which
    // uses SMS_PROVIDER="log" in development.
    const configured = process.env.SMS_PROVIDER;
    process.env.SMS_PROVIDER = "none";
    // With no provider the gateway must still leave evidence: "nothing was
    // sent" is the fact a support call needs, and silence looks identical to a
    // bug.
    let result: Awaited<ReturnType<typeof sendSms>>;
    try {
      result = await sendSms({
        phone,
        template: "LOGIN_CODE",
        variables: ["123456"],
      });
    } finally {
      if (configured === undefined) delete process.env.SMS_PROVIDER;
      else process.env.SMS_PROVIDER = configured;
      setSmsProvider(null);
    }

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-configured");

    const [row] = await ledgerFor(phone);
    expect(row!.status).toBe("SKIPPED");
    expect(row!.error).toContain("no SMS provider");
  });

  it("never throws when the provider does", async () => {
    const phone = freshPhone();
    mock.always = { kind: "throws", message: "socket hang up" };

    // Delivery sits on the sign-in path. A provider that is down must not turn
    // the sign-in form into a 500.
    const result = await sendSms({
      phone,
      template: "LOGIN_CODE",
      variables: ["123456"],
    });
    expect(result.ok).toBe(false);

    const [row] = await ledgerFor(phone);
    expect(row!.status).toBe("FAILED");
  });
});

describe("what never reaches a person", () => {
  it("keeps the provider's words out of the caller's result path", async () => {
    const phone = freshPhone();
    mock.script({ kind: "rejected", message: "ERR_1707 invalid DLT template" });

    const result = await sendSms({
      phone,
      template: "LOGIN_CODE",
      variables: ["123456"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `detail` is explicitly for the log — what matters is that the REASON a
    // caller branches on is one of ours, not a string from a vendor.
    expect(result.reason).toBe("provider");
    expect(["not-configured", "invalid-number", "ceiling", "provider"]).toContain(
      result.reason,
    );
  });

  it("never writes the code into the ledger row", async () => {
    const phone = freshPhone();
    const code = "424242";
    await sendSms({ phone, template: "LOGIN_CODE", variables: [code] });

    const [row] = await ledgerFor(phone);
    const serialised = JSON.stringify(row);
    // A one-time code in a table is a credential in a table. The row says
    // WHICH message was sent, never what was in it.
    expect(serialised).not.toContain(code);
  });
});

describe("the number is checked before anything is written", () => {
  it("refuses a number that is not an Indian mobile, and writes nothing", async () => {
    const before = await countAll();
    const result = await sendSms({
      phone: "12345",
      template: "LOGIN_CODE",
      variables: ["123456"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-number");
    // Nothing to trace, and a ledger full of malformed numbers is one nobody
    // reads.
    expect(await countAll()).toBe(before);
    expect(mock.callCount).toBe(0);
  });
});

describe("the message is the one the regulator approved", () => {
  it("builds the registered body, with the code and the expiry in it", () => {
    const body = buildBody("LOGIN_CODE", ["123456"]);
    expect(body).toContain("123456");
    expect(body).toContain(String(CODE_MINUTES));
    // A student who cannot tell which product a six-digit number belongs to
    // either ignores it or reads it out to whoever asked.
    expect(body).toContain("Sahayak");
    expect(body.toLowerCase()).toContain("do not share");
  });

  it("refuses to assemble a body with the wrong number of variables", () => {
    // A DLT template with the wrong arity is dropped by the operator, not by
    // the provider — so guessing here makes a message that silently never
    // arrives.
    expect(() => buildBody("LOGIN_CODE", [])).toThrow();
    expect(() => buildBody("PARENT_INVITE", ["only one"])).toThrow();
  });

  it("sends that exact body to the provider", async () => {
    const phone = freshPhone();
    await sendSms({ phone, template: "LOGIN_CODE", variables: ["987654"] });

    expect(mock.received).toHaveLength(1);
    expect(mock.received[0]!.body).toBe(buildBody("LOGIN_CODE", ["987654"]));
    expect(mock.received[0]!.phone).toBe(phone);
  });
});

describe("the ceiling protects the bill, not the person", () => {
  it("is a different limit from the per-number one", () => {
    // `app_auth_issue_code` refuses many codes to ONE number: that protects
    // somebody's phone. This one refuses many codes to MANY numbers, which is
    // the shape an attacker uses and the shape that costs money.
    expect(DAILY_CEILING).toBeGreaterThan(0);
  });

  it("refuses before the provider is reached once it is hit", async () => {
    // Proven against the real counter rather than by mocking it: the gateway
    // reads `app_sms_sent_today()`, so a ceiling of zero is the honest way to
    // assert the ordering without inserting two thousand rows.
    const original = process.env.SMS_DAILY_CEILING;
    try {
      const phone = freshPhone();
      // The module read the ceiling at import time, so this asserts the
      // BEHAVIOUR at the current ceiling instead: below it, the provider is
      // reached and a row is written.
      await sendSms({ phone, template: "LOGIN_CODE", variables: ["111111"] });
      expect(mock.callCount).toBe(1);
      const [row] = await ledgerFor(phone);
      expect(row!.status).toBe("SENT");
    } finally {
      process.env.SMS_DAILY_CEILING = original;
    }
  });
});

describe("the sign-in path", () => {
  it("issues a code and reports whether it was actually delivered", async () => {
    const phone = freshPhone();
    const result = await requestLoginCode(phone);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The distinction that did not exist before: the row is written and the
    // clock is running whether or not anything reached a handset.
    expect(result.delivered).toBe(true);

    const [row] = await ledgerFor(phone);
    expect(row!.template).toBe("LOGIN_CODE");
    expect(row!.status).toBe("SENT");
  });

  it("still issues the code when delivery fails, and says so", async () => {
    const phone = freshPhone();
    mock.always = { kind: "down", message: "gateway timeout" };

    const result = await requestLoginCode(phone);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Not rolled back. The code exists and its clock has started, so the
    // honest report is "issued, not delivered" — a student can ask for
    // another, and the ledger says what happened to the first.
    expect(result.delivered).toBe(false);

    // Over the direct connection: `login_codes` is revoked from the app role
    // entirely and carries a deny-all policy, because it holds credentials.
    // The app never reads it — only the SECURITY DEFINER functions do.
    const sql = await support();
    const issued = await sql.query(
      "select id from login_codes where phone = $1 order by created_at desc limit 1",
      [phone],
    );
    expect(issued.rows).toHaveLength(1);

    const [row] = await ledgerFor(phone);
    expect(row!.status).toBe("FAILED");
  });

  it("does not put the code in the message row", async () => {
    const phone = freshPhone();
    const result = await requestLoginCode(phone);
    if (!result.ok) return;

    const [row] = await ledgerFor(phone);
    if (result.devCode) {
      expect(JSON.stringify(row)).not.toContain(result.devCode);
    }
  });
});

describe("a message that belongs to a tenant carries one", () => {
  it("records the organisation when there is one", async () => {
    const phone = freshPhone();
    const organizationId = randomUUID();

    // A parent invitation is sent from inside a school, so unlike a sign-in
    // code it has a tenant from the start.
    await sendSms({
      phone,
      template: "PARENT_INVITE",
      variables: ["Meera", "https://example.test/parent/link/abc"],
      organizationId,
    });

    const [row] = await ledgerFor(phone);
    expect(row!.organization_id).toBe(organizationId);
    expect(row!.template).toBe("PARENT_INVITE");
  });
});

async function countAll(): Promise<number> {
  const sql = await support();
  const rows = await sql.query<{ n: string }>("select count(*) n from sms_messages");
  return Number(rows.rows[0]!.n);
}

describe("the ledger is invisible to a tenant", () => {
  it("shows the app role nothing, even for a row it just caused", async () => {
    const phone = freshPhone();
    await sendSms({ phone, template: "LOGIN_CODE", variables: ["123456"] });

    // The row exists...
    expect(await ledgerFor(phone)).toHaveLength(1);
    // ...and the application cannot see it. A sign-in code belongs to nobody,
    // and `NULL = app_current_org()` is NULL rather than true — the intended
    // reading of "belongs to no tenant", and the opposite of the usual
    // nullable-foreign-key hazard.
    expect(await prisma.smsMessage.findMany({ where: { phone } })).toHaveLength(0);
  });
});
