import { PrismaClient } from "@prisma/client";

/**
 * The Prisma client. Never used directly by feature code — go through
 * withTenant() in ./tenant, or the four narrow functions in ./unscoped.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
