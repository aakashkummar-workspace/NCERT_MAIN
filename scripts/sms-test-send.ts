/**
 * Check the SMS configuration, and send ONE real test message when asked.
 *
 *     npx tsx --conditions=react-server scripts/sms-test-send.ts
 *     npx tsx --conditions=react-server scripts/sms-test-send.ts --to 98XXXXXXXX --send
 *
 * Without `--send` it sends nothing: it prints which provider is configured,
 * which variables are missing, and the exact text of every template next to
 * the DLT template id it will be sent under — the text a registration must
 * match character for character, or the operator drops the message silently.
 *
 * With `--send` it goes through `sendSms()`, the one door the product uses, so
 * the daily ceiling applies and the attempt is written to the SMS ledger like
 * any sign-in code. The test code is random and is not a valid sign-in code
 * for anything.
 *
 * See docs/SMS_SETUP.md for the paperwork this depends on.
 */
import { randomInt } from "node:crypto";
import { checkEnvironment } from "../src/config/environment";
import { sendSms } from "../src/sms/gateway";
import { configuredProvider, hasSmsCredentials } from "../src/sms/provider";
import { CODE_MINUTES, TEMPLATES } from "../src/sms/templates";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

async function main() {
  const provider = configuredProvider();
  const report = checkEnvironment();
  const sms = [...report.fatal, ...report.degraded].filter((f) => f.key.startsWith("SMS"));

  console.log(`\nSMS provider: ${provider}${provider === "msg91" ? (hasSmsCredentials() ? " (credentials present)" : " (CREDENTIALS MISSING)") : ""}`);
  for (const finding of sms) console.log(`  ${finding.key}: ${finding.message}\n    → ${finding.fix}`);

  console.log("\nTemplates — register these EXACT texts with DLT, variables as {#var#}:");
  const placeholders: Record<string, string[]> = {
    LOGIN_CODE: ["{#var#}"],
    PARENT_INVITE: ["{#var#}", "{#var#}"],
  };
  for (const template of Object.values(TEMPLATES)) {
    const text = template.build(placeholders[template.key] ?? []);
    console.log(`\n  ${template.key}  (DLT id: ${template.dltTemplateId || "NOT SET"})`);
    console.log(`  ${text}`);
  }
  console.log(`\n  (The sign-in code lives ${CODE_MINUTES} minutes; the message says so.)`);

  if (!process.argv.includes("--send")) {
    console.log("\nNothing sent. Add --to <10-digit mobile> --send to send one test sign-in message.");
    return;
  }

  const to = arg("--to");
  if (!to) throw new Error("--send needs --to <10-digit mobile number>.");
  if (provider === "none") throw new Error("SMS_PROVIDER is none, so nothing would be sent.");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const outcome = await sendSms({ phone: to, template: "LOGIN_CODE", variables: [code] });
  console.log("\nResult:", JSON.stringify(outcome, null, 2));
  if (outcome.ok && provider === "msg91") {
    console.log("\nMSG91 accepted it. Accepted is not delivered: check the phone, and MSG91's delivery report, before trusting the setup.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
