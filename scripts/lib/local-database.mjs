/**
 * Refuses to let a test suite touch any database but a local one.
 *
 * The integration suite, the smoke scripts and the browser tests each create
 * hundreds of throwaway organisations, users, papers and curriculum fixtures
 * per run — the local database reached ~17,000 organisations that way. Pointed
 * at Supabase, where the real schools live, one run would bury them.
 *
 * So every suite calls this first. It reads the same environment the app and
 * the dev server read, which is the point: if `.env` points at Supabase, the
 * server a smoke script talks to is writing to Supabase too, and refusing here
 * is the only moment left to stop it. To run the tests, point `.env` (or the
 * shell) at the local Docker database.
 *
 * A deliberate override exists for a dedicated, disposable TEST project:
 * SAHAYAK_ALLOW_REMOTE_TESTS=1. Never set it for the real database.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function assertLocalDatabase(suite, env = process.env) {
  if (env.SAHAYAK_ALLOW_REMOTE_TESTS === "1") return;
  const remote = ["DATABASE_URL", "DIRECT_URL", "PLATFORM_DATABASE_URL"]
    .map((key) => ({ key, host: env[key] ? hostOf(env[key]) : null }))
    .filter((entry) => entry.host && !LOCAL_HOSTS.has(entry.host));
  if (remote.length === 0) return;

  const lines = remote.map((entry) => `  ${entry.key} → ${entry.host}`).join("\n");
  throw new Error(
    `${suite} refuses to run against a remote database:\n${lines}\n\n` +
      "Tests create thousands of throwaway organisations and users. Point .env at the local " +
      "Docker database (npm run db:up) to run them. For a disposable test project only, " +
      "set SAHAYAK_ALLOW_REMOTE_TESTS=1.",
  );
}
