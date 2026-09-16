/**
 * Runs once, before the server takes its first request.
 *
 * The only thing here is the configuration report. Almost every capability in
 * this product degrades quietly when its environment variable is missing — the
 * AI layer falls back to a mock, the cron routes refuse everything, sign-in
 * codes go nowhere — and each of those is a good decision on its own. Together
 * they let a deployment come up green and be unable to sign a single student
 * in, with nothing saying so.
 *
 * So it is said here, at boot, where a deploy log will carry it.
 */
export async function register() {
  // Only in the Node runtime: the edge runtime has neither the environment nor
  // a console anybody reads.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportEnvironment } = await import("@/config/environment");
  reportEnvironment();
}
