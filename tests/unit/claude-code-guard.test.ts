import { describe, expect, it } from "vitest";
import { claudeCodeAllowed, isLocalDatabaseUrl } from "@/ai/local-database";

/**
 * The Claude Code provider answers through a developer's own login, which
 * Anthropic allows for their own testing and never for a product other people
 * use. These are the conditions that keep it there.
 */

const LOCAL = "postgres://app@localhost:5434/sahayak";
const SUPABASE = "postgres://app.ref@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";
const env = (over: Record<string, string | undefined>) => over as unknown as NodeJS.ProcessEnv;

describe("the Claude Code provider", () => {
  it("runs only when asked for, on a local database, outside a test run", () => {
    expect(claudeCodeAllowed(env({ AI_PROVIDER: "claude-code", DATABASE_URL: LOCAL }))).toBe(true);
  });

  it("never runs against a remote database", () => {
    expect(claudeCodeAllowed(env({ AI_PROVIDER: "claude-code", DATABASE_URL: SUPABASE }))).toBe(false);
  });

  it("never runs inside a test suite", () => {
    expect(claudeCodeAllowed(env({ AI_PROVIDER: "claude-code", DATABASE_URL: LOCAL, VITEST: "true" }))).toBe(false);
    // And this suite is one: the real environment must refuse.
    expect(claudeCodeAllowed()).toBe(false);
  });

  it("is off unless named", () => {
    expect(claudeCodeAllowed(env({ DATABASE_URL: LOCAL }))).toBe(false);
  });

  it("treats a malformed or missing URL as not local", () => {
    expect(isLocalDatabaseUrl(undefined)).toBe(false);
    expect(isLocalDatabaseUrl("not a url")).toBe(false);
    expect(isLocalDatabaseUrl("postgres://x@127.0.0.1:5434/db")).toBe(true);
  });
});
