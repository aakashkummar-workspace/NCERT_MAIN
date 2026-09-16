import { PrismaClient } from "@prisma/client";

/**
 * The curriculum-authoring connection.
 *
 * Connects as `sahayak_platform`, a role that exists for one reason: the write
 * policies on the curriculum tables are scoped TO it. `sahayak_app` — the role
 * every ordinary request holds — has no insert, update or delete grant on those
 * tables and matches no write policy on them.
 *
 * That makes the boundary structural rather than procedural. A teacher-facing
 * route physically cannot write curriculum, whatever an authorization check
 * does or forgets to do; the role check in application code is the second line
 * of defence, not the only one.
 *
 * Neither role has BYPASSRLS. Tenant isolation is unaffected here.
 *
 * An ESLint rule confines this module to src/core/curriculum/admin.ts.
 */
const globalForPlatform = globalThis as unknown as {
  platformPrisma: PrismaClient | undefined;
};

function makeClient(): PrismaClient {
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) {
    throw new Error(
      "PLATFORM_DATABASE_URL is not set. Curriculum authoring runs as its own " +
        "database role — see .env.example and run: npm run db:rls",
    );
  }
  return new PrismaClient({
    datasources: { db: { url } },
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const platformPrisma =
  globalForPlatform.platformPrisma ?? makeClient();

if (process.env.NODE_ENV !== "production") {
  globalForPlatform.platformPrisma = platformPrisma;
}
