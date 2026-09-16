import type { ClientConfig } from "pg";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

/**
 * pg client options for a connection string, local or Supabase.
 *
 * For a remote host, `sslmode` is removed from the URL and TLS is set here:
 * with `sslmode=require` in the string, pg verifies the certificate chain
 * against a CA it does not ship, and Supabase's pooler fails with
 * "self-signed certificate in certificate chain". The connection stays
 * encrypted. Prisma reads the same URL and handles `sslmode` itself.
 */
export function pgConfig(url: string): ClientConfig {
  const parsed = new URL(url);
  if (LOCAL.has(parsed.hostname)) return { connectionString: url };
  parsed.searchParams.delete("sslmode");
  // Prisma's pool settings; pg does not read them.
  parsed.searchParams.delete("connection_limit");
  parsed.searchParams.delete("pool_timeout");
  return { connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } };
}
