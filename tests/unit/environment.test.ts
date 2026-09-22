import { describe, expect, it } from "vitest";
import { checkEnvironment } from "@/config/environment";

/**
 * The distinction under test is fatal-versus-degraded, and it is the whole
 * point of the module.
 *
 * A capability that is legitimately off must never stop a deployment: refusing
 * to boot over a missing AI key would make the product undeployable for anybody
 * not paying for AI. A configuration that CONTRADICTS ITSELF must stop it,
 * because that is somebody who meant to turn something on and mistyped.
 */

const base: Record<string, string | undefined> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://app@localhost:5434/sahayak",
  DIRECT_URL: "postgres://postgres@localhost:5434/sahayak",
};

// Built as a plain record and widened once, rather than asserted per call:
// `ProcessEnv` requires NODE_ENV, so the shorter `as NodeJS.ProcessEnv` was a
// lie that `tsc` caught only at build time — vitest does not typecheck.
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ ...base, ...over }) as unknown as NodeJS.ProcessEnv;

const keys = (findings: { key: string }[]) => findings.map((f) => f.key);

describe("what nothing works without", () => {
  it("is fatal when there is no database", () => {
    const report = checkEnvironment(env({ DATABASE_URL: undefined }));
    expect(keys(report.fatal)).toContain("DATABASE_URL");
  });

  it("is fatal when there is no direct connection", () => {
    // Migrations and the RLS policies both need it, and RLS is the one thing
    // in this product that must never be applied halfway.
    const report = checkEnvironment(env({ DIRECT_URL: undefined }));
    expect(keys(report.fatal)).toContain("DIRECT_URL");
  });

  it("treats an empty string as missing", () => {
    // `.env.example` ships every key with `""`, so a copied file has the name
    // present and the value blank. That is not configured.
    const report = checkEnvironment(env({ DATABASE_URL: "   " }));
    expect(keys(report.fatal)).toContain("DATABASE_URL");
  });
});

describe("a configuration that contradicts itself", () => {
  it("is fatal when a real SMS gateway is named without credentials", () => {
    const report = checkEnvironment(env({ SMS_PROVIDER: "msg91" }));
    // Not "SMS is off". Somebody asked for a gateway; falling back to sending
    // nothing hides a typo behind a deployment that looks fine and cannot sign
    // anybody in.
    expect(keys(report.fatal)).toContain("SMS_PROVIDER");
    expect(report.fatal[0]!.message).toMatch(/delivered nowhere/i);
    // And it says which variable, rather than "check your configuration".
    expect(report.fatal[0]!.fix).toMatch(/SMS_API_KEY/);
  });

  it("names only the credential that is actually missing", () => {
    const report = checkEnvironment(
      env({ SMS_PROVIDER: "msg91", SMS_API_KEY: "k" }),
    );
    expect(report.fatal[0]!.message).toContain("SMS_SENDER_ID");
    expect(report.fatal[0]!.message).not.toContain("SMS_API_KEY");
  });

  it("is fatal when codes would be printed to a production log", () => {
    const report = checkEnvironment(
      env({ SMS_PROVIDER: "log", NODE_ENV: "production" }),
    );
    // A one-time code in a log file is a credential in a log file.
    expect(keys(report.fatal)).toContain("SMS_PROVIDER");
  });

  it("allows the log provider outside production", () => {
    const report = checkEnvironment(
      env({ SMS_PROVIDER: "log", NODE_ENV: "development" }),
    );
    expect(report.fatal).toHaveLength(0);
    expect(report.live.join(" ")).toMatch(/SMS: log/);
  });
});

describe("a capability that is legitimately off", () => {
  it("reports a missing SMS provider without refusing to start", () => {
    const report = checkEnvironment(env());
    expect(report.fatal).toHaveLength(0);
    expect(keys(report.degraded)).toContain("SMS_PROVIDER");
    // The consequence, in the words somebody needs to hear it in.
    expect(report.degraded.find((f) => f.key === "SMS_PROVIDER")!.message).toMatch(
      /no student can sign in by phone/i,
    );
  });

  it("reports a missing AI key without refusing to start", () => {
    const report = checkEnvironment(env());
    expect(keys(report.degraded)).toContain("ANTHROPIC_API_KEY");
    // Refusing to boot here would make the product undeployable for anybody
    // not paying for AI.
    expect(report.fatal).toHaveLength(0);
  });

  it("reports a missing cron secret and names what stops running", () => {
    const report = checkEnvironment(env());
    const finding = report.degraded.find((f) => f.key === "CRON_SECRET")!;
    // "Scheduled jobs are disabled" is not actionable. Which jobs, and what
    // goes stale, is.
    expect(finding.message).toMatch(/mastery|swept|classified/i);
  });

  it("says what IS live, not only what is not", () => {
    const report = checkEnvironment(
      env({
        ANTHROPIC_API_KEY: "sk-x",
        CRON_SECRET: "c",
        SMS_PROVIDER: "log",
        WHATSAPP_PROVIDER: "log",
        QUESTION_LIBRARY_SOURCE: "sirah-digital",
      }),
    );
    expect(report.live).toContain("AI: Anthropic");
    expect(report.live).toContain("Scheduled jobs");
    expect(report.degraded).toHaveLength(0);
  });
});

describe("a message that arrives nowhere is worse than one that fails", () => {
  it("warns when a real gateway has no DLT template registered", () => {
    const report = checkEnvironment(
      env({ SMS_PROVIDER: "msg91", SMS_API_KEY: "k", SMS_SENDER_ID: "SAHYAK" }),
    );
    expect(report.fatal).toHaveLength(0);
    expect(keys(report.degraded)).toContain("SMS_TEMPLATE_LOGIN_CODE");
    // The reason this is not merely cosmetic: an unregistered message is
    // dropped by the operator, so the provider reports success and the ledger
    // records a send that never happened.
    expect(
      report.degraded.find((f) => f.key === "SMS_TEMPLATE_LOGIN_CODE")!.message,
    ).toMatch(/recorded as sent and never arrive/i);
  });

  it("is clean once both templates are registered", () => {
    const report = checkEnvironment(
      env({
        SMS_PROVIDER: "msg91",
        SMS_API_KEY: "k",
        SMS_SENDER_ID: "SAHYAK",
        SMS_TEMPLATE_LOGIN_CODE: "17071",
        SMS_TEMPLATE_PARENT_INVITE: "17072",
        WHATSAPP_PROVIDER: "meta",
        WHATSAPP_TOKEN: "t",
        WHATSAPP_PHONE_NUMBER_ID: "123",
        ANTHROPIC_API_KEY: "sk-x",
        CRON_SECRET: "c",
        QUESTION_LIBRARY_SOURCE: "sirah-digital",
      }),
    );
    expect(report.fatal).toHaveLength(0);
    expect(report.degraded).toHaveLength(0);
    expect(report.live).toContain("SMS: msg91");
  });
});

describe("every finding is actionable", () => {
  it("names a variable and what to do, never 'check your configuration'", () => {
    const report = checkEnvironment(
      env({ DATABASE_URL: undefined, SMS_PROVIDER: "msg91" }),
    );
    for (const finding of [...report.fatal, ...report.degraded]) {
      expect(finding.key.length).toBeGreaterThan(0);
      expect(finding.message.length).toBeGreaterThan(20);
      expect(finding.fix.length).toBeGreaterThan(10);
      expect(finding.fix.toLowerCase()).not.toContain("check your configuration");
    }
  });
});

describe("the question library", () => {
  it("says a new school starts with an empty bank when no source is set", () => {
    const report = checkEnvironment(env({}));
    const finding = report.degraded.find((f) => f.key === "QUESTION_LIBRARY_SOURCE");
    expect(finding?.message).toMatch(/empty question bank/i);
  });

  it("says whether the NCERT Exemplar questions are included", () => {
    expect(checkEnvironment(env({ QUESTION_LIBRARY_SOURCE: "s" })).live).toContain(
      "Question library (original questions only)",
    );
    expect(
      checkEnvironment(env({ QUESTION_LIBRARY_SOURCE: "s", QUESTION_LIBRARY_INCLUDE_EXEMPLAR: "true" })).live,
    ).toContain("Question library (including NCERT Exemplar)");
  });
});

describe("WhatsApp", () => {
  it("is fatal when Meta is named without its credentials", () => {
    const report = checkEnvironment(env({ WHATSAPP_PROVIDER: "meta" }));
    expect(report.fatal.map((finding) => finding.key)).toContain("WHATSAPP_PROVIDER");
  });

  it("is only reported when it is off", () => {
    const report = checkEnvironment(env());
    expect(report.fatal.map((finding) => finding.key)).not.toContain("WHATSAPP_PROVIDER");
    expect(report.degraded.map((finding) => finding.key)).toContain("WHATSAPP_PROVIDER");
  });
});

describe("the Claude Code provider is for local testing only", () => {
  const SUPABASE = "postgres://app.ref@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";

  it("is live on a local database, and says it is for testing", () => {
    const report = checkEnvironment(env({ AI_PROVIDER: "claude-code" }));
    expect(report.fatal).toHaveLength(0);
    expect(report.live).toContain("AI: Claude Code login (local testing only)");
  });

  it("is fatal on any database that is not on this machine", () => {
    // Anthropic does not allow a subscription login to power a product other
    // people use, and every real deployment has a remote database.
    const report = checkEnvironment(env({ AI_PROVIDER: "claude-code", DATABASE_URL: SUPABASE }));
    expect(keys(report.fatal)).toContain("AI_PROVIDER");
  });

  it("is fatal when the provider name is not one this product knows", () => {
    const report = checkEnvironment(env({ AI_PROVIDER: "claude" }));
    expect(keys(report.fatal)).toContain("AI_PROVIDER");
  });

  it("leaves the API key path exactly as it was when unset", () => {
    const report = checkEnvironment(env({ ANTHROPIC_API_KEY: "sk-x", DATABASE_URL: SUPABASE }));
    expect(keys(report.fatal)).not.toContain("AI_PROVIDER");
    expect(report.live).toContain("AI: Anthropic");
  });
});
