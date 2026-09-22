/**
 * What this deployment can and cannot do, decided once, out loud.
 *
 * ---------------------------------------------------------------------------
 * The failure this exists to prevent
 * ---------------------------------------------------------------------------
 * Almost every capability in this product degrades quietly when its environment
 * variable is missing. No `ANTHROPIC_API_KEY` and the AI layer falls back to a
 * mock — deliberate, so the whole product runs in development. No `CRON_SECRET`
 * and the scheduled jobs refuse everything — deliberate, so a forgotten secret
 * cannot leave them open. No SMS provider and sign-in codes are issued and
 * delivered nowhere.
 *
 * Each of those is a good decision on its own. Together they mean a deployment
 * can come up entirely green, serve pages, and be unable to sign a single
 * student in — with nothing anywhere saying so. The first person to find out is
 * a fifteen-year-old holding a phone that never buzzes.
 *
 * So: one place that says what is live, printed at boot, before the server
 * takes a request.
 *
 * ---------------------------------------------------------------------------
 * Fatal, degraded, and the difference
 * ---------------------------------------------------------------------------
 * FATAL is for things the product cannot run without at all, and for
 * CONTRADICTIONS — a configuration that states an intent it cannot carry out.
 * `SMS_PROVIDER=msg91` with no API key is not "SMS is off", it is somebody who
 * meant to turn SMS on and mistyped a variable name. Falling back silently
 * turns their mistake into a product that looks fine and cannot sign anybody
 * in, which is the exact failure above.
 *
 * DEGRADED is for a capability that is genuinely, legitimately off. It is
 * reported and never fatal, because refusing to boot over a missing AI key
 * would make the product undeployable for anybody not paying for AI.
 */

export type Finding = {
  key: string;
  message: string;
  /** What a reader should do about it. Never "check your configuration". */
  fix: string;
};

export type EnvironmentReport = {
  fatal: Finding[];
  degraded: Finding[];
  /** Capabilities confirmed live, so the log says what works as well as what does not. */
  live: string[];
};

function present(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim() !== "";
}

export function checkEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentReport {
  const has = (name: string) =>
    typeof env[name] === "string" && env[name]!.trim() !== "";

  const fatal: Finding[] = [];
  const degraded: Finding[] = [];
  const live: string[] = [];

  // --- Things nothing works without ---------------------------------------

  if (!has("DATABASE_URL")) {
    fatal.push({
      key: "DATABASE_URL",
      message: "There is no database connection string.",
      fix: "Set DATABASE_URL to the sahayak_app connection. See .env.example.",
    });
  }
  if (!has("DIRECT_URL")) {
    fatal.push({
      key: "DIRECT_URL",
      message:
        "There is no direct connection string. Migrations and the RLS policies cannot be applied without it.",
      fix: "Set DIRECT_URL to the superuser connection. See .env.example.",
    });
  }

  // --- Contradictions: an intent that cannot be carried out ----------------

  const smsProvider = (env.SMS_PROVIDER ?? "none").trim().toLowerCase();

  if (smsProvider === "msg91") {
    const missing = ["SMS_API_KEY", "SMS_SENDER_ID"].filter((name) => !has(name));
    if (missing.length > 0) {
      // Fatal, not degraded. Somebody asked for a real gateway; falling back to
      // sending nothing would hide a typo behind a working-looking deployment.
      fatal.push({
        key: "SMS_PROVIDER",
        message: `SMS_PROVIDER is "msg91" but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. Sign-in codes would be issued and delivered nowhere.`,
        fix: `Set ${missing.join(" and ")}, or set SMS_PROVIDER="none" to say plainly that SMS is off.`,
      });
    } else {
      live.push("SMS: msg91");
      // A registered template id is required per message type in India. Without
      // it the operator drops the message at the network, silently — which is
      // worse than not sending, because the ledger will record a success.
      for (const [name, what] of [
        ["SMS_TEMPLATE_LOGIN_CODE", "sign-in codes"],
        ["SMS_TEMPLATE_PARENT_INVITE", "parent invitations"],
      ] as const) {
        if (!has(name)) {
          degraded.push({
            key: name,
            message: `No DLT template id for ${what}. India's operators drop an unregistered message at the network, so it will be recorded as sent and never arrive.`,
            fix: `Register the template in your DLT account and set ${name}.`,
          });
        }
      }
    }
  } else if (smsProvider === "log") {
    if (env.NODE_ENV === "production") {
      fatal.push({
        key: "SMS_PROVIDER",
        message:
          'SMS_PROVIDER is "log" in production. Sign-in codes would be written to the server log instead of sent.',
        fix: 'Set SMS_PROVIDER="msg91" with credentials, or "none".',
      });
    } else {
      live.push("SMS: log (codes print to this terminal)");
    }
  } else {
    degraded.push({
      key: "SMS_PROVIDER",
      message:
        "No SMS provider. Sign-in codes are issued and delivered nowhere, so no student can sign in by phone — only with a printed sign-in card.",
      fix: 'Set SMS_PROVIDER="log" for development, or "msg91" with credentials.',
    });
  }

  // WhatsApp: the same three states as SMS. "meta" without a token is a typo
  // behind a working-looking deployment, so it is fatal; "none" is a real
  // state and only reported.
  const whatsappProvider = (env.WHATSAPP_PROVIDER ?? "none").trim().toLowerCase();
  if (whatsappProvider === "meta") {
    const missing = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"].filter((name) => !has(name));
    if (missing.length > 0) {
      fatal.push({
        key: "WHATSAPP_PROVIDER",
        message: `WHATSAPP_PROVIDER is "meta" but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. Parents who asked for a weekly summary would receive nothing.`,
        fix: `Set ${missing.join(" and ")}, or set WHATSAPP_PROVIDER="none".`,
      });
    } else {
      live.push("WhatsApp: Meta Cloud API (weekly parent digest)");
    }
  } else if (whatsappProvider === "log") {
    live.push("WhatsApp: log (digests print to this terminal)");
  } else {
    degraded.push({
      key: "WHATSAPP_PROVIDER",
      message:
        "No WhatsApp provider. Parents are not offered the weekly WhatsApp summary.",
      fix: 'Register the "weekly_progress_digest" template with Meta, then set WHATSAPP_PROVIDER="meta" with WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.',
    });
  }

  // --- Capabilities that are legitimately off ------------------------------

  if (has("ANTHROPIC_API_KEY")) {
    live.push("AI: Anthropic");
  } else {
    degraded.push({
      key: "ANTHROPIC_API_KEY",
      message:
        "No AI key. Question generation, the Copilot, the tutor and concept drafting all answer with the mock provider.",
      fix: "Set ANTHROPIC_API_KEY, or leave it unset and the product runs without AI.",
    });
  }

  if (has("QUESTION_LIBRARY_SOURCE")) {
    live.push(
      env.QUESTION_LIBRARY_INCLUDE_EXEMPLAR?.trim() === "true"
        ? "Question library (including NCERT Exemplar)"
        : "Question library (original questions only)",
    );
  } else {
    degraded.push({
      key: "QUESTION_LIBRARY_SOURCE",
      message:
        "No question library source, so new schools start with an empty question bank.",
      fix: "Set QUESTION_LIBRARY_SOURCE to the slug of the organization whose approved questions every CBSE school should receive (e.g. sirah-digital), and schedule POST /api/cron/share-library/.",
    });
  }

  if (has("CRON_SECRET")) {
    live.push("Scheduled jobs");
  } else {
    degraded.push({
      key: "CRON_SECRET",
      message:
        "No cron secret, so every scheduled job refuses. Mastery will not decay, attempts will not be swept, mistakes will not be classified, and the cross-school benchmarks will not be recomputed.",
      fix: "Set CRON_SECRET and give the same value to whatever calls /api/cron/*.",
    });
  }

  return { fatal, degraded, live };
}

/**
 * Print it, and refuse to start if the configuration contradicts itself.
 *
 * Called from `instrumentation.ts`, which Next runs once per server before the
 * first request. A check that runs on first use instead would report a missing
 * SMS provider to whichever student happened to try first.
 */
export function reportEnvironment(): EnvironmentReport {
  const report = checkEnvironment();

  for (const item of report.live) {
    console.info(`[config] ${item}`);
  }
  for (const finding of report.degraded) {
    console.warn(`[config] ${finding.key}: ${finding.message}\n          ${finding.fix}`);
  }
  for (const finding of report.fatal) {
    console.error(`[config] ${finding.key}: ${finding.message}\n          ${finding.fix}`);
  }

  if (report.fatal.length > 0 && process.env.NODE_ENV === "production") {
    // Refused in production only. A developer with half an environment should
    // still be able to run the parts that work; a production deployment that
    // contradicts itself should not come up at all.
    throw new Error(
      `Refusing to start: ${report.fatal.length} configuration ${report.fatal.length === 1 ? "problem" : "problems"} above.`,
    );
  }

  return report;
}

export { present };
