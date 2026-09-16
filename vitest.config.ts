import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws when resolved outside a React Server Component
      // graph. Its build-time guarantee is unaffected — `npm run build` still
      // fails if a client component imports a server module.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // A real Postgres, with migrations applied. An in-memory substitute
          // cannot exercise RLS, and RLS is the tenancy mechanism — mocking the
          // database means never testing the thing that keeps schools apart.
          setupFiles: ["tests/integration/setup.ts"],
          // Removes the curriculum the run authored. The curriculum plane has no
          // tenant, so without this every fixture concept is permanent and global.
          globalSetup: ["tests/integration/global-setup.ts"],
          // One fork: these tests share a database, and parallel files racing
          // over the same rows produce failures that look like tenancy bugs.
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
