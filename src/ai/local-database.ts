/**
 * Whether a connection string points at this machine.
 *
 * The same test `scripts/lib/local-database.mjs` makes before any test suite
 * runs, and for the same reason: every real deployment has a remote database,
 * so "the database is local" is the one reliable sign that nobody but the
 * developer is using this server.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether the development-only Claude Code provider may run here: asked for,
 * AND on a local database, AND not inside a test run. See src/ai/claude-code.ts
 * for the first two; the third is because the suites rely on the mock being the
 * default, and a `.env` set up for local testing must not turn every run into
 * real model calls.
 */
export function claudeCodeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.AI_PROVIDER?.trim() === "claude-code" &&
    isLocalDatabaseUrl(env.DATABASE_URL) &&
    !env.VITEST
  );
}
